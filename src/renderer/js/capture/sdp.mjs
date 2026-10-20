// SDP descriptions are declarations from one signaling message, not negotiated
// media or evidence of RTP/SRTP playback. RFC 8866 owns inheritance/defaults;
// RFC 3264 defines port zero, RFC 3605 the explicit RTCP attribute.
export const SDP_LIMITS = Object.freeze({ maxChars: 256 * 1024, maxLines: 2048, maxLineChars: 8192, maxMedia: 64, maxFormats: 128, maxWarnings: 64 });
const DIRECTIONS = new Set(['sendrecv', 'sendonly', 'recvonly', 'inactive']);
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const RTP = /(?:^|\/)RTP\//;
const number = (text, min, max = Number.MAX_SAFE_INTEGER) => /^\d+$/.test(text || '') && Number.isSafeInteger(Number(text)) && Number(text) >= min && Number(text) <= max ? Number(text) : null;
const state = (value) => ({ value, directionSeen: false, connectionSeen: false, rtcpSeen: false, maps: new Map(), parameters: new Map() });
const connection = (raw) => {
  const parts = /^([^\s]+) +([^\s]+) +([^\s]+)$/.exec(raw);
  return parts ? { networkType: parts[1], addressType: parts[2], address: parts[3], raw } : null;
};

/** Parse bounded, untrusted SDP text without executing or fetching its contents.
 * Unknown attributes and unmodeled lines remain available verbatim. `complete`
 * means no detected malformed fields or limits, not validated extensions or a
 * successful offer/answer exchange. Null means an absent or ambiguous fact.
 */
export function parseSdp(text) {
  const result = {
    sessionName: null, origin: null, connection: null, timing: null, timings: [],
    direction: 'sendrecv', directionSource: 'default', media: [], attributes: [],
    unknownLines: [], warnings: [], complete: true, rawText: '',
  };
  const warn = (message) => {
    result.complete = false;
    if (result.warnings.length < SDP_LIMITS.maxWarnings) result.warnings.push(message);
    else if (result.warnings.length === SDP_LIMITS.maxWarnings) result.warnings.push('Further SDP warnings omitted.');
  };
  if (typeof text !== 'string') { warn('SDP body is not text.'); return result; }
  result.rawText = text.slice(0, SDP_LIMITS.maxChars);
  if (text.length > result.rawText.length) warn('SDP text limit reached; remaining text was not parsed or retained.');
  const session = state(result);
  const mediaStates = [];
  const seen = new Set();
  let current = session;
  let cursor = 0;
  let lineNumber = 0;
  while (cursor < result.rawText.length) {
    if (++lineNumber > SDP_LIMITS.maxLines) { warn('SDP line limit reached; later fields were not parsed.'); break; }
    const newline = result.rawText.indexOf('\n', cursor);
    const end = newline < 0 ? result.rawText.length : newline;
    let raw = result.rawText.slice(cursor, end);
    cursor = newline < 0 ? result.rawText.length : newline + 1;
    if (raw.endsWith('\r') && newline >= 0) raw = raw.slice(0, -1);
    if (raw.length > SDP_LIMITS.maxLineChars) { warn(`SDP line ${lineNumber} exceeds the line size limit; parsing stopped.`); break; }
    const match = /^([a-z])=(.*)$/.exec(raw);
    if (!match || /[\0\r]/.test(raw)) {
      current.value.unknownLines.push({ type: null, value: raw, raw, line: lineNumber });
      if (match?.[1] === 'c') { current.connectionSeen = true; current.value.connection = null; }
      warn(`Malformed SDP line ${lineNumber}.`);
      continue;
    }
    const [, type, value] = match;
    const retained = { type, value, raw, line: lineNumber };
    if (type === 'm') {
      if (result.media.length >= SDP_LIMITS.maxMedia) { warn('SDP media limit reached; later media was not parsed.'); break; }
      const parts = value.split(/ +/);
      const portParts = /^(\d+)(?:\/(\d+))?$/.exec(parts[1] || '');
      const media = {
        type: TOKEN.test(parts[0] || '') ? parts[0] : null,
        port: portParts ? number(portParts[1], 0, 65535) : null,
        portCount: portParts ? (portParts[2] == null ? 1 : number(portParts[2], 1, 65535)) : null,
        protocol: /^[A-Za-z0-9][A-Za-z0-9/.-]*$/.test(parts[2] || '') ? parts[2] : null,
        formats: parts.slice(3, 3 + SDP_LIMITS.maxFormats), connection: null,
        connectionSource: null, direction: null, directionSource: null,
        codecs: [], rtcp: null, attributes: [], unknownLines: [], disabled: false,
      };
      media.disabled = media.port === 0;
      if (!media.type || media.port == null || media.portCount == null || !media.protocol || !media.formats.length || media.formats.some((format) => !TOKEN.test(format))) warn(`Malformed media description on SDP line ${lineNumber}.`);
      if (parts.length - 3 > SDP_LIMITS.maxFormats) warn(`SDP format limit reached on line ${lineNumber}.`);
      result.media.push(media);
      current = state(media);
      mediaStates.push(current);
    } else if (type === 'c') {
      const parsed = connection(value);
      if (current.connectionSeen) {
        current.value.connection = null;
        warn(`Multiple connection lines in one SDP scope (line ${lineNumber}); a single address cannot be asserted. Inspect raw SDP.`);
      } else {
        current.value.connection = parsed;
        if (!parsed) warn(`Malformed connection information on SDP line ${lineNumber}.`);
      }
      current.connectionSeen = true;
    } else if (type === 'a') {
      const colon = value.indexOf(':');
      const attribute = { name: colon < 0 ? value : value.slice(0, colon), value: colon < 0 ? null : value.slice(colon + 1), raw, line: lineNumber };
      current.value.attributes.push(attribute);
      const name = attribute.name;
      const av = attribute.value;
      if (!TOKEN.test(name)) { warn(`Malformed attribute name on SDP line ${lineNumber}.`); continue; }
      if (DIRECTIONS.has(name)) {
        const valid = av === null;
        if (!valid || current.directionSeen) {
          if (!valid || current.value.direction !== name) current.value.direction = null;
          warn(`Invalid or repeated media direction on SDP line ${lineNumber}.`);
        } else current.value.direction = name;
        current.directionSeen = true;
      } else if (['rtpmap', 'fmtp', 'rtcp'].includes(name)) {
        if (current === session) { warn(`Media-only ${name} attribute at session level on SDP line ${lineNumber}.`); continue; }
        if (name === 'rtpmap') {
          const mapping = /^(\d+) +([^\s/]+)\/(\d+)(?:\/(\d+))?$/.exec(av || '');
          const payloadType = mapping?.[1];
          const clockRate = mapping ? number(mapping[3], 1) : null;
          const channels = mapping?.[4] == null ? (current.value.type === 'audio' ? 1 : null) : number(mapping[4], 1);
          if (!mapping || number(payloadType, 0, 127) == null || !TOKEN.test(mapping[2]) || clockRate == null || (mapping[4] != null && channels == null)) {
            const declared = /^(\d+)(?: |$)/.exec(av || '');
            if (declared) current.maps.set(declared[1], null);
            warn(`Malformed rtpmap on SDP line ${lineNumber}.`);
          } else if (current.maps.has(payloadType)) {
            current.maps.set(payloadType, null);
            warn(`Repeated rtpmap for payload ${payloadType} on SDP line ${lineNumber}; mapping is ambiguous.`);
          } else current.maps.set(payloadType, { name: mapping[2], clockRate, channels });
        } else if (name === 'fmtp') {
          const parameters = /^([^\s]+) +(.+)$/.exec(av || '');
          if (!parameters) {
            const declared = /^([^\s]+)(?: |$)/.exec(av || '');
            if (declared) current.parameters.set(declared[1], null);
            warn(`Malformed fmtp on SDP line ${lineNumber}.`);
          }
          else if (current.parameters.has(parameters[1])) {
            current.parameters.set(parameters[1], null);
            warn(`Repeated fmtp for format ${parameters[1]} on SDP line ${lineNumber}; parameters are ambiguous.`);
          } else current.parameters.set(parameters[1], parameters[2]);
        } else {
          const parts = av?.split(/ +/) || [];
          const port = number(parts[0], 0, 65535);
          const address = parts.length === 4 ? connection(parts.slice(1).join(' ')) : null;
          if (current.rtcpSeen || port == null || (parts.length !== 1 && (parts.length !== 4 || !address))) {
            current.value.rtcp = null;
            warn(`Malformed or repeated rtcp on SDP line ${lineNumber}.`);
          } else current.value.rtcp = { port, connection: address, raw: av };
          current.rtcpSeen = true;
        }
      }
    } else if (['v', 'o', 's', 't'].includes(type)) {
      if (current !== session) { current.value.unknownLines.push(retained); warn(`Session-only ${type}= field inside media on SDP line ${lineNumber}.`); continue; }
      if (type !== 't' && seen.has(type)) { warn(`Repeated ${type}= field on SDP line ${lineNumber}.`); continue; }
      seen.add(type);
      if (type === 'v' && (value !== '0' || lineNumber !== 1)) warn(`Invalid SDP version or position on line ${lineNumber}.`);
      else if (type === 'o') {
        if (/^[^\s]+ +\d+ +\d+ +[^\s]+ +[^\s]+ +[^\s]+$/.test(value)) result.origin = value;
        else warn(`Malformed origin on SDP line ${lineNumber}.`);
      } else if (type === 's') {
        if (value.length) result.sessionName = value;
        else warn(`Empty session name on SDP line ${lineNumber}.`);
      } else if (type === 't') {
        const timing = /^(\d+) +(\d+)$/.exec(value);
        if (timing) {
          const item = { start: timing[1], stop: timing[2], raw: value };
          result.timings.push(item);
          result.timing ??= item;
        } else warn(`Malformed timing on SDP line ${lineNumber}.`);
      }
    } else {
      current.value.unknownLines.push(retained);
      if (!'iuepbrzk'.includes(type)) warn(`Unknown SDP field ${type}= on line ${lineNumber}; retained without interpretation.`);
    }
  }
  for (const field of ['v', 'o', 's', 't']) if (!seen.has(field)) warn(`Missing required SDP ${field}= field.`);
  result.directionSource = session.directionSeen ? 'session' : 'default';
  for (const mediaState of mediaStates) {
    const media = mediaState.value;
    media.connectionSource = mediaState.connectionSeen ? 'media' : session.connectionSeen ? 'session' : null;
    if (!mediaState.connectionSeen) media.connection = result.connection;
    if (!media.connection) warn(`Media ${media.type || '(unknown)'} has no unambiguous connection address.`);
    media.directionSource = mediaState.directionSeen ? 'media' : result.directionSource;
    if (!mediaState.directionSeen) media.direction = result.direction;
    if (RTP.test(media.protocol || '')) {
      media.codecs = media.formats.map((payloadType) => {
        if (number(payloadType, 0, 127) == null) warn(`Invalid RTP payload type ${payloadType}.`);
        let mapping = mediaState.maps.get(payloadType);
        let mappingSource = mapping ? 'rtpmap' : null;
        // RFC 3551 Table 4, restricted to the verified RTP/AVP audio profile.
        if (!mediaState.maps.has(payloadType) && media.type === 'audio' && media.protocol === 'RTP/AVP' && ['0', '8'].includes(payloadType)) {
          mapping = { name: payloadType === '0' ? 'PCMU' : 'PCMA', clockRate: 8000, channels: 1 };
          mappingSource = 'static';
        }
        if (!mapping && number(payloadType, 96, 127) != null) warn(`Dynamic RTP payload ${payloadType} has no unambiguous rtpmap; codec is unknown.`);
        return { payloadType, name: mapping?.name ?? null, clockRate: mapping?.clockRate ?? null, channels: mapping?.channels ?? null, fmtp: mediaState.parameters.get(payloadType) ?? null, mappingSource };
      });
    }
    for (const key of new Set([...mediaState.maps.keys(), ...mediaState.parameters.keys()])) if (!media.formats.includes(key)) warn(`Attribute references format ${key} absent from its media description.`);
  }
  return result;
}
