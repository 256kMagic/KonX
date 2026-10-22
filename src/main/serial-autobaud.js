'use strict';

// Byte readability is evidence for a likely console rate, not a measurement of
// the UART clock. Require one plausible candidate and a separate fresh sample.
const BAUD_RATES = Object.freeze([9600, 115200, 57600, 38400, 19200, 4800, 2400, 1200, 230400, 460800, 921600]);
const MAX_SAMPLE_BYTES = 8192;
const TIMING = Object.freeze({ settleMs: 80, sampleMs: 550, confirmationMs: 1100, operationMs: 2000 });

function scoreSample(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) return { plausible: false, score: 0, reason: 'silent', bytes: 0 };
  if (bytes.length > MAX_SAMPLE_BYTES) return { plausible: false, score: 0, reason: 'oversized', bytes: bytes.length };
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return { plausible: false, score: 0, reason: 'invalid encoding', bytes: bytes.length }; }
  text = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
  const chars = [...text];
  const bad = chars.filter(char => !/[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}\r\n\t\b]/u.test(char)).length;
  const readable = chars.length ? (chars.length - bad) / chars.length : 0;
  // Unexpected controls or replacement characters are not evidence of a console.
  if (bad || readable < 0.98 || text.includes('\ufffd')) return { plausible: false, score: 0, reason: 'binary or noise', bytes: bytes.length };
  const lines = text.replace(/\x08/g, '').split(/[\r\n]+/).map(line => line.trim()).filter(Boolean);
  const prompt = lines.some(line => /^(?:[A-Za-z][A-Za-z0-9_.@:/~()-]{1,79}[#>$]|(?:[\w.-]+\s+)?(?:login|username|password)\s*:)$/i.test(line));
  const words = text.match(/\p{L}{2,}/gu) || [];
  const letters = new Set((text.toLowerCase().match(/\p{L}/gu) || []));
  const prose = text.trim().length >= 48 && words.length >= 5 && letters.size >= 8 && /[\r\n]|\w[.!?:]\s/.test(text);
  const plausible = prompt || prose;
  return { plausible, score: prompt ? 100 : prose ? 85 : 0, reason: prompt ? 'console prompt' : prose ? 'readable console text' : 'insufficient console text', bytes: bytes.length };
}

function unsupportedRate(error) {
  return ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(error?.code)
    // bindings-cpp's Windows UpdateWorker drops code 87 and supplies this exact
    // message. Other SetCommState failures (access/handle/removal) stay fatal.
    || error?.message === 'Update (SetCommState): The parameter is incorrect'
    || /(?:baud.*(?:unsupported|not supported|invalid)|(?:unsupported|invalid).*baud)/i.test(error?.message || '');
}

async function detectBaud({ setBaudRate, sample, progress, check, probe = false }) {
  const candidates = [];
  const total = BAUD_RATES.length;
  for (let i = 0; i < total; i++) {
    check();
    const baudRate = BAUD_RATES[i], index = i + 1;
    try { await setBaudRate(baudRate); }
    catch (error) {
      check();
      if (!unsupportedRate(error)) throw error;
      progress({ phase: 'unsupported', baudRate, index, total, message: `Skipping ${baudRate} baud: this adapter does not support it.` });
      continue;
    }
    check();
    progress({ phase: 'sampling', baudRate, index, total, message: `${probe ? 'Probing' : 'Listening at'} ${baudRate} baud (${index}/${total})…` });
    const observation = await sample(false);
    const assessment = observation.truncated
      ? { plausible: false, score: 0, reason: 'sample exceeded byte limit', bytes: observation.bytes.length }
      : scoreSample(observation.bytes);
    candidates.push({ baudRate, ...assessment });
  }
  check();
  const plausible = candidates.filter(candidate => candidate.plausible);
  if (plausible.length > 1) throw new Error(`Auto baud is ambiguous: readable output appeared at ${plausible.map(candidate => candidate.baudRate).join(', ')} baud. Choose a fixed baud rate from the device documentation.`);
  if (!plausible.length) {
    const silent = candidates.every(candidate => candidate.bytes === 0);
    throw new Error(`${silent ? 'Auto baud received no serial output.' : 'Auto baud could not identify readable console output.'} ${probe ? 'Check the cable and device console settings, or choose a fixed baud rate.' : 'Try again with “Send Enter while detecting” enabled, or choose a fixed baud rate.'}`);
  }
  const chosen = plausible[0];
  await setBaudRate(chosen.baudRate);
  check();
  progress({ phase: 'confirming', baudRate: chosen.baudRate, index: BAUD_RATES.indexOf(chosen.baudRate) + 1, total,
    message: `Confirming likely ${chosen.baudRate} baud with fresh output…` });
  const observation = await sample(true), confirmedSample = observation.bytes;
  const confirmation = observation.truncated ? { plausible: false } : scoreSample(confirmedSample);
  check();
  if (!confirmation.plausible) throw new Error(`Auto baud could not confirm ${chosen.baudRate} baud with fresh readable output. Try again or choose a fixed baud rate.`);
  return { baudRate: chosen.baudRate, sample: confirmedSample,
    summary: { method: 'heuristic', confidence: 'likely', baudRate: chosen.baudRate, probe, candidatesTested: candidates.length, score: confirmation.score, confirmed: true } };
}

module.exports = { BAUD_RATES, MAX_SAMPLE_BYTES, TIMING, scoreSample, detectBaud };
