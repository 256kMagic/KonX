// HTTP/1 messages over reassembled bytes. Never parse across a missing-byte range.
// Packet decoding remains useful for individual packets; this owns message framing.
const LIMITS = {
  maxInputBytes: 16 * 1024 * 1024,
  maxHeaderBytes: 64 * 1024,
  maxBodyBytes: 8 * 1024 * 1024,
  maxDecodedBytes: 16 * 1024 * 1024,
  maxMessages: 200,
  maxChunks: 16384,
  maxPreviewBytes: 128 * 1024,
};
const ascii = new TextDecoder('iso-8859-1');
const token = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const requestLine = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+) ([^\x00-\x20\x7f]+) HTTP\/(1\.[01])$/;
const responseLine = /^HTTP\/(1\.[01]) ([1-5][0-9]{2})(?: ([^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*))?$/;
const CRLF = [13, 10];
const HEADER_END = [13, 10, 13, 10];
const trimOws = (value) => value.replace(/^[ \t]+|[ \t]+$/g, '');

function find(bytes, pattern, start = 0, end = bytes.length) {
  outer: for (let i = start; i <= end - pattern.length; i++) {
    for (let j = 0; j < pattern.length; j++) if (bytes[i + j] !== pattern[j]) continue outer;
    return i;
  }
  return -1;
}

function concat(parts, length = parts.reduce((n, part) => n + part.length, 0)) {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

function headersFrom(lines) {
  const headers = [];
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 1 || !token.test(line.slice(0, colon))) return { headers, error: 'Invalid HTTP header name or obsolete folded header.' };
    const rawValue = line.slice(colon + 1);
    if (/[\x00-\x08\x0a-\x1f\x7f]/.test(rawValue)) return { headers, error: 'Invalid control byte in an HTTP header.' };
    // Only HTTP OWS (SP / HTAB) may be normalized, after validating wire bytes.
    const value = trimOws(rawValue);
    headers.push({ name: line.slice(0, colon), value });
  }
  return { headers };
}

function values(headers, name) {
  return headers.filter((h) => h.name.toLowerCase() === name).map((h) => h.value);
}

function overlaps(a, b, start, end) { return a < end && b > start; }

function sourceFrames(ranges, start, end) {
  const frames = new Set();
  for (const range of ranges) {
    if (range.kind !== 'data' || !overlaps(range.start, range.end, start, end)) continue;
    const sources = range.sources?.filter((s) => overlaps(s.start, s.end, start, end));
    for (const frame of sources?.length ? sources.map((s) => s.frame) : range.frames || []) frames.add(frame);
  }
  return [...frames].sort((a, b) => a - b);
}

function inputFor(direction, limits) {
  const parts = [];
  let length = 0, end = null, start = 0, stopped = false, limited = false;
  const warnings = [];
  for (const range of direction.ranges || []) {
    if (range.kind === 'gap') {
      stopped = true;
      warnings.push(`HTTP parsing stops at ${range.length} missing TCP bytes; later bytes are not joined across the gap.`);
      break;
    }
    if (range.kind !== 'data' || !range.data?.length) continue;
    if (end !== null && range.start !== end) {
      stopped = true;
      warnings.push('Noncontiguous TCP byte ranges stop HTTP parsing.');
      break;
    }
    if (end === null) start = range.start;
    const available = Math.max(0, limits.maxInputBytes - length);
    const part = range.data.subarray(0, available);
    parts.push(part);
    length += part.length;
    end = range.start + part.length;
    if (part.length < range.data.length) {
      limited = true;
      warnings.push(`HTTP input is limited to ${limits.maxInputBytes} bytes per direction.`);
      break;
    }
  }
  return { bytes: concat(parts, length), start, stopped, limited, warnings };
}

function classify(bytes) {
  const eol = find(bytes, CRLF, 0, Math.min(bytes.length, 8192));
  const line = ascii.decode(bytes.subarray(0, eol < 0 ? Math.min(bytes.length, 8192) : eol));
  if (requestLine.test(line)) return 'request';
  if (responseLine.test(line)) return 'response';
  return null;
}

function readChunked(bytes, start, limits) {
  let pos = start, length = 0, chunks = 0;
  const parts = [];
  const result = (error, complete = false, trailers = []) => ({ body: concat(parts, length), end: pos, error, complete, trailers });
  while (pos < bytes.length) {
    if (++chunks > limits.maxChunks) return result(`HTTP chunk count exceeds the ${limits.maxChunks}-chunk limit.`);
    const lineEnd = find(bytes, CRLF, pos, Math.min(bytes.length, pos + 8192));
    if (lineEnd < 0) return result('Chunk size line is incomplete or exceeds 8 KiB.');
    const sizeLine = ascii.decode(bytes.subarray(pos, lineEnd));
    const match = /^([0-9a-fA-F]+)(?:;[^\x00-\x08\x0a-\x1f\x7f]*)?$/.exec(sizeLine);
    if (!match) return result('Invalid HTTP chunk size.');
    const size = Number.parseInt(match[1], 16);
    pos = lineEnd + 2;
    if (!Number.isSafeInteger(size) || size > limits.maxBodyBytes - length) return result(`Chunked body exceeds the ${limits.maxBodyBytes}-byte limit.`);
    if (size === 0) {
      if (bytes[pos] === 13 && bytes[pos + 1] === 10) { pos += 2; return result(null, true); }
      const trailerEnd = find(bytes, HEADER_END, pos, Math.min(bytes.length, pos + limits.maxHeaderBytes));
      if (trailerEnd < 0) return result('HTTP trailers are incomplete or exceed the header limit.');
      const parsed = headersFrom(ascii.decode(bytes.subarray(pos, trailerEnd)).split('\r\n'));
      pos = trailerEnd + 4;
      if (parsed.error) return result(parsed.error);
      if (parsed.headers.some((h) => /^(content-length|transfer-encoding)$/i.test(h.name))) return result('Framing fields are not allowed in HTTP trailers.');
      return result(null, true, parsed.headers);
    }
    const available = Math.min(size, bytes.length - pos);
    parts.push(bytes.subarray(pos, pos + available));
    length += available;
    pos += available;
    if (available !== size) return result('Captured HTTP chunk data is incomplete.');
    if (bytes[pos] !== 13 || bytes[pos + 1] !== 10) return result('HTTP chunk terminator is missing or invalid.');
    pos += 2;
  }
  return result('The terminating HTTP chunk was not captured.');
}

function parseDirection(direction, kind, requests, limits, budget, input = inputFor(direction, limits)) {
  const { bytes } = input;
  const warnings = [...input.warnings];
  const messages = [];
  let pos = 0, requestIndex = 0, stopped = false;
  while (pos < bytes.length && budget.messages < limits.maxMessages) {
    const begin = pos;
    const lineEnd = find(bytes, CRLF, pos, Math.min(bytes.length, pos + limits.maxHeaderBytes));
    const line = ascii.decode(bytes.subarray(pos, lineEnd < 0 ? Math.min(bytes.length, pos + limits.maxHeaderBytes) : lineEnd));
    const match = kind === 'request' ? requestLine.exec(line) : responseLine.exec(line);
    if (!match) {
      warnings.push(`${bytes.length - pos} bytes are not a complete HTTP/1 ${kind} start line; parsing stops here.`);
      break;
    }
    const message = {
      id: `${direction.fromA ? 'a' : 'b'}-${input.start + begin}`,
      fromA: direction.fromA, type: kind, startLine: line,
      method: kind === 'request' ? match[1] : null,
      target: kind === 'request' ? match[2] : null,
      version: kind === 'request' ? match[3] : match[1],
      status: kind === 'response' ? Number(match[2]) : null,
      reason: kind === 'response' ? match[3] || '' : null,
      headers: [], trailers: [], body: new Uint8Array(), decodedBody: null,
      text: null, mediaType: '', bodyEncoding: 'identity', framing: 'none',
      frames: [], complete: false, exportable: false, warnings: [],
      start: input.start + begin, end: input.start + begin, previewTruncated: false,
    };
    budget.messages++;
    messages.push(message);
    const finish = () => {
      message.end = input.start + pos;
      message.frames = sourceFrames(direction.ranges || [], message.start, message.end);
      if ((direction.conflicts || []).some((c) => overlaps(c.start, c.end, message.start, message.end))) {
        message.complete = false;
        message.warnings.push('Conflicting TCP overlap affects this message; displayed bytes are ambiguous.');
      }
      if (direction.limited || input.limited) {
        message.complete = false;
        message.warnings.push('TCP/HTTP resource limits prevent verifying this message.');
      }
      if (direction.truncated) {
        message.complete = false;
        message.warnings.push('Truncated captured packets prevent verifying this message.');
      }
    };
    const headerEnd = find(bytes, HEADER_END, pos, Math.min(bytes.length, pos + limits.maxHeaderBytes));
    if (headerEnd < 0) {
      pos = Math.min(bytes.length, pos + limits.maxHeaderBytes);
      message.warnings.push(`HTTP headers are incomplete or exceed ${limits.maxHeaderBytes} bytes.`);
      finish();
      stopped = true;
      break;
    }
    const parsed = headersFrom(ascii.decode(bytes.subarray(lineEnd + 2, headerEnd)).split('\r\n').filter(Boolean));
    message.headers = parsed.headers;
    pos = headerEnd + 4;
    if (parsed.error) {
      message.warnings.push(parsed.error);
      finish();
      stopped = true;
      break;
    }
    message.mediaType = trimOws((values(message.headers, 'content-type')[0] || '').split(';')[0]).toLowerCase();
    const transfer = values(message.headers, 'transfer-encoding').join(',').toLowerCase().split(',').map(trimOws).filter(Boolean);
    const lengths = values(message.headers, 'content-length').flatMap((s) => s.split(',').map(trimOws));
    const validLengths = lengths.length && lengths.every((s) => /^\d+$/.test(s) && Number.isSafeInteger(Number(s)) && Number(s) === Number(lengths[0]));
    const request = kind === 'response' ? requests[requestIndex] : null;
    const unknownRequest = kind === 'response' && !request && message.status >= 200 && ![204, 304].includes(message.status);
    const noBody = kind === 'response' && (
      (message.status >= 100 && message.status < 200) || [204, 304].includes(message.status) ||
      request?.method === 'HEAD' || (request?.method === 'CONNECT' && message.status >= 200 && message.status < 300)
    );
    const switching = kind === 'response' && (message.status === 101 || (request?.method === 'CONNECT' && message.status >= 200 && message.status < 300));
    // RFC 9112 section 6.3: HEAD/status/CONNECT rules precede framing fields.
    if (!noBody && ((lengths.length && !validLengths) || (lengths.length && transfer.length))) {
      message.warnings.push(transfer.length ? 'Both Transfer-Encoding and Content-Length are present; framing is ambiguous.' : 'Invalid or conflicting Content-Length values.');
      finish();
      stopped = true;
      break;
    }
    if (noBody) {
      message.complete = true;
      if ((lengths.length && !validLengths) || (lengths.length && transfer.length)) message.warnings.push('Invalid framing headers ignored because this response cannot contain a body.');
    } else if (transfer.length) {
      message.framing = 'chunked';
      if (message.version === '1.0' || transfer.length !== 1 || transfer[0] !== 'chunked') {
        message.warnings.push(message.version === '1.0' ? 'Transfer-Encoding is invalid in HTTP/1.0.' : `Unsupported Transfer-Encoding: ${transfer.join(', ')}.`);
        finish();
        stopped = true;
        break;
      }
      const chunked = readChunked(bytes, pos, limits);
      message.body = chunked.body;
      message.trailers = chunked.trailers;
      pos = chunked.end;
      message.complete = chunked.complete;
      if (chunked.error) message.warnings.push(chunked.error);
    } else if (lengths.length) {
      message.framing = 'content-length';
      const length = Number(lengths[0]);
      const available = Math.min(length, bytes.length - pos, limits.maxBodyBytes);
      message.body = bytes.subarray(pos, pos + available);
      pos += available;
      message.complete = length === available;
      if (length > limits.maxBodyBytes) message.warnings.push(`HTTP body exceeds the ${limits.maxBodyBytes}-byte limit.`);
      else if (!message.complete) message.warnings.push(`HTTP body is incomplete: ${available} of ${length} bytes captured before a gap or capture end.`);
    } else if (kind === 'request') {
      message.complete = true;
    } else {
      message.framing = 'connection-close';
      const available = Math.min(bytes.length - pos, limits.maxBodyBytes);
      message.body = bytes.subarray(pos, pos + available);
      pos += available;
      message.complete = !!direction.closed && !direction.reset && !input.stopped && !direction.limited && !input.limited && !direction.truncated && pos === bytes.length;
      if (!message.complete) message.warnings.push('Close-delimited response is incomplete without a captured orderly FIN and all body bytes.');
    }
    if (unknownRequest) {
      message.complete = false;
      message.warnings.push('No unambiguous captured request identifies HEAD/CONNECT semantics; response framing is provisional.');
    }
    finish();
    if (kind === 'response' && !(message.status >= 100 && message.status < 200 && message.status !== 101)) requestIndex++;
    if (switching) {
      warnings.push('The connection switches protocol here; tunneled or upgraded bytes are not parsed as HTTP/1.');
      stopped = true;
      break;
    }
    if (!message.complete) { stopped = true; break; }
  }
  if (budget.messages >= limits.maxMessages && pos < bytes.length) {
    warnings.push(`HTTP message count is limited to ${limits.maxMessages}; remaining messages are not parsed.`);
    budget.limited = true;
  }
  if (input.limited) budget.limited = true;
  return { messages, warnings, stopped };
}

async function contentDecode(message, limits, budget) {
  const encodings = values(message.headers, 'content-encoding').join(',').toLowerCase().split(',').map(trimOws).filter((s) => s && s !== 'identity');
  message.bodyEncoding = encodings.join(', ') || 'identity';
  let bytes = message.body;
  const remaining = Math.max(0, limits.maxDecodedBytes - budget.decodedBytes);
  if (bytes.length > remaining) {
    message.warnings.push('Decoded-body memory limit reached.');
    budget.limited = true;
    return;
  }
  if (encodings.length && !(message.framing === 'none' && !bytes.length)) {
    if (!message.complete) {
      message.warnings.push('Incomplete compressed bodies are not decompressed.');
      return;
    }
    if (encodings.length !== 1 || !['gzip', 'deflate'].includes(encodings[0]) || typeof DecompressionStream === 'undefined') {
      message.warnings.push(`Content-Encoding ${message.bodyEncoding} is not supported by this decoder.`);
      return;
    }
    let reader;
    try {
      reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(encodings[0])).getReader();
      let length = 0;
      const parts = [];
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.length;
        if (length > remaining || length > limits.maxBodyBytes) {
          await reader.cancel();
          message.warnings.push('Decompressed body exceeds the output limit.');
          budget.limited = true;
          return;
        }
        parts.push(next.value);
      }
      bytes = concat(parts, length);
    } catch {
      message.warnings.push(`Invalid or incomplete ${message.bodyEncoding} content; decoded bytes are unavailable.`);
      return;
    } finally {
      reader?.releaseLock();
    }
  }
  message.decodedBody = bytes;
  budget.decodedBytes += bytes.length;
  message.exportable = message.complete;
  const contentType = values(message.headers, 'content-type')[0] || '';
  const textual = /^text\//.test(message.mediaType) || /(?:json|xml|javascript|x-www-form-urlencoded)$/.test(message.mediaType);
  const preview = bytes.subarray(0, limits.maxPreviewBytes);
  const plausibleText = !message.mediaType && !preview.subarray(0, 4096).some((b) => b < 32 && ![9, 10, 13].includes(b));
  if (!textual && !plausibleText && bytes.length) return;
  const charset = /charset[ \t]*=[ \t]*"?([^"; \t]+)/i.exec(contentType)?.[1] || 'utf-8';
  try {
    const text = new TextDecoder(charset, { fatal: true }).decode(preview, { stream: preview.length < bytes.length });
    message.text = text;
    message.previewTruncated = preview.length < bytes.length;
    if (!message.previewTruncated && /(?:^|[+/])json$/.test(message.mediaType)) {
      try {
        const formatted = JSON.stringify(JSON.parse(text), null, 2);
        message.text = formatted.slice(0, limits.maxPreviewBytes);
        message.previewTruncated = formatted.length > limits.maxPreviewBytes;
      } catch { message.warnings.push('Body is declared JSON but is not valid JSON.'); }
    }
  } catch {
    message.warnings.push(`Body cannot be decoded as ${charset}; use the raw stream view or export complete bytes.`);
  }
}

/**
 * Return evidence-backed HTTP/1 messages and request/response exchanges.
 * body is dechunked wire content; decodedBody is content-decoded and exportable only
 * when `exportable` is true. Text is a bounded plain-text preview, never HTML markup.
 */
export async function parseHttpStream(stream, options = {}) {
  const limits = Object.fromEntries(Object.entries(LIMITS).map(([key, cap]) => [
    key, Number.isSafeInteger(options[key]) && options[key] > 0 ? Math.min(options[key], cap) : cap,
  ]));
  const result = { recognized: false, exchanges: [], messages: [], warnings: [], truncated: false };
  if (!stream || (stream.conv?.proto && stream.conv.proto !== 'TCP')) return result;
  const directions = (stream.directions || []).map((direction) => {
    const input = inputFor(direction, limits);
    return { direction, input, kind: classify(input.bytes) };
  });
  const requestDirection = directions.find((d) => d.kind === 'request');
  const responseDirection = directions.find((d) => d.kind === 'response');
  if (!requestDirection && !responseDirection) {
    result.warnings = directions.flatMap((d) => d.input.warnings);
    result.truncated = !!stream.limited || directions.some((d) => d.input.limited);
    return result;
  }
  result.recognized = true;
  const budget = { messages: 0, decodedBytes: 0, limited: false };
  const requests = requestDirection ? parseDirection(requestDirection.direction, 'request', [], limits, budget, requestDirection.input) : { messages: [], warnings: [] };
  // The first parsed message must be at the captured direction boundary. Missing
  // requests are never silently skipped in order to align a later response.
  const canPair = !!requestDirection && !!responseDirection &&
    requestDirection.direction.startKnown && responseDirection.direction.startKnown &&
    !requestDirection.direction.limited && !responseDirection.direction.limited &&
    !requestDirection.direction.truncated && !responseDirection.direction.truncated &&
    !(requestDirection.direction.conflicts || []).length && !(responseDirection.direction.conflicts || []).length;
  const responses = responseDirection ? parseDirection(responseDirection.direction, 'response', canPair ? requests.messages : [], limits, budget, responseDirection.input) : { messages: [], warnings: [] };
  result.messages = [...requests.messages, ...responses.messages];
  result.warnings.push(...requests.warnings, ...responses.warnings);
  if (!canPair && requests.messages.length && responses.messages.length) result.warnings.push('Unverified connection starts, conflicting bytes, capture truncation or limits prevent reliable pairing; request/response pairing is not asserted.');
  for (const message of result.messages) await contentDecode(message, limits, budget);
  if (canPair) {
    let index = 0;
    for (const request of requests.messages) result.exchanges.push({ id: request.id, request, response: null, informational: [], warnings: [] });
    for (const response of responses.messages) {
      let exchange = result.exchanges[index];
      if (!exchange) {
        exchange = { id: response.id, request: null, response: null, informational: [], warnings: ['No captured request for this response.'] };
        result.exchanges.push(exchange);
      }
      if (response.status >= 100 && response.status < 200 && response.status !== 101) exchange.informational.push(response);
      else { exchange.response = response; index++; }
    }
  } else {
    for (const message of result.messages) result.exchanges.push({
      id: message.id, request: message.type === 'request' ? message : null,
      response: message.type === 'response' ? message : null, informational: [], warnings: [],
    });
  }
  result.truncated = budget.limited || !!stream.limited;
  return result;
}
