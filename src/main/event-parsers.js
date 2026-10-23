'use strict';

// Parse only the bytes of one bounded UDP datagram. No MIB lookup, clock
// inference, authentication, outbound traffic, or raw SNMP retention occurs.
const MAX_DATAGRAM_BYTES = 8192;
const MAX_VARBINDS = 64;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const malformed = () => { throw new Error('Malformed event'); };
const nil = value => value === '-' ? null : value;

function timestamp(value) {
  if (value === '-') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) malformed();
  const [, y, mo, d, h, mi, s, fraction, zone] = match;
  const year = +y, month = +mo, day = +d;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  if (month < 1 || month > 12 || day < 1 || day > [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] || +h > 23 || +mi > 59 || +s > 59) malformed();
  if (zone !== 'Z' && (+zone.slice(1, 3) > 23 || +zone.slice(4) > 59)) malformed();
  // Preserve exact offset and sub-millisecond precision instead of guessing a
  // timezone or truncating the source timestamp through Date serialization.
  return value;
}

function structuredData(text) {
  if (text[0] === '-') {
    if (text.length > 1 && text[1] !== ' ') malformed();
    return { elements: [], message: text.length > 1 ? text.slice(2) : '' };
  }
  let at = 0; const elements = [], ids = new Set();
  const name = () => {
    const start = at;
    while (at < text.length && /[\x21-\x7e]/.test(text[at]) && !/[="\]]/.test(text[at])) at++;
    const value = text.slice(start, at); if (!value || value.length > 32) malformed(); return value;
  };
  while (text[at] === '[') {
    if (elements.length >= 32) malformed();
    at++; const id = name(), params = [];
    if (ids.has(id)) malformed(); ids.add(id);
    while (text[at] === ' ') {
      if (params.length >= 64) malformed();
      at++; const key = name();
      if (text.slice(at, at + 2) !== '="') malformed(); at += 2;
      let value = '', ended = false;
      while (at < text.length) {
        const ch = text[at++];
        if (ch === '"') { ended = true; break; }
        if (ch === ']') malformed();
        if (ch === '\\') {
          const next = text[at];
          if (next === '"' || next === '\\' || next === ']') { value += next; at++; }
          else value += ch; // RFC5424: preserve a backslash before another character.
        } else value += ch;
      }
      if (!ended) malformed(); params.push({ name: key, value });
    }
    if (text[at++] !== ']') malformed(); elements.push({ id, params });
  }
  if (!elements.length || (at < text.length && text[at] !== ' ')) malformed();
  return { elements, message: at < text.length ? text.slice(at + 1) : '' };
}

function parseSyslog(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_DATAGRAM_BYTES) throw new TypeError('Expected a bounded event datagram');
  let text;
  try { text = utf8.decode(bytes); }
  catch { return { protocol: 'syslog', format: 'unparsed', parseStatus: 'invalid', timestamp: null, timestampText: null, message: bytes.toString('utf8'), reason: 'Invalid UTF-8; replacement characters shown.' }; }
  try {
    const pri = /^<(0|[1-9]\d{0,2})>/.exec(text);
    if (!pri || +pri[1] > 191) malformed();
    const facility = Math.floor(+pri[1] / 8), severity = +pri[1] % 8, body = text.slice(pri[0].length);
    const modern = /^(\d{1,3}) (\S+) (\S+) (\S+) (\S+) (\S+) ([\s\S]*)$/.exec(body);
    if (modern) {
      if (modern[1] !== '1') return { protocol: 'syslog', format: 'unparsed', parseStatus: 'unsupported', timestamp: null, timestampText: null, facility, severity, message: text, reason: 'Unsupported syslog version.' };
      const [, , time, host, app, process, msgId, rest] = modern;
      for (const [value, limit] of [[host, 255], [app, 48], [process, 128], [msgId, 32]]) if (!/^[\x21-\x7e]+$/.test(value) || value.length > limit) malformed();
      const sourceTime = timestamp(time), sd = structuredData(rest);
      return { protocol: 'syslog', format: 'rfc5424', parseStatus: 'parsed', facility, severity, timestamp: sourceTime, timestampText: nil(time),
        hostname: nil(host), appName: nil(app), procId: nil(process), msgId: nil(msgId), structuredData: sd.elements,
        messageEncoding: sd.message.startsWith('\uFEFF') ? 'utf8-bom' : 'unspecified-decoded-as-utf8', message: sd.message.replace(/^\uFEFF/, '') };
    }
    const legacy = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([ 1-3]\d) (\d{2}):(\d{2}):(\d{2}) ([!-~]+) ([\s\S]*)$/.exec(body);
    if (!legacy) malformed();
    const [, month, day, hour, minute, second, host, message] = legacy;
    if (+day < 1 || +day > [31,29,31,30,31,30,31,31,30,31,30,31][['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(month)] || +hour > 23 || +minute > 59 || +second > 59 || host.length > 255) malformed();
    const tag = /^([A-Za-z0-9]{1,32})(?:\[(\d{1,20})\])?: ?([\s\S]*)$/.exec(message);
    return { protocol: 'syslog', format: 'rfc3164', parseStatus: 'parsed', facility, severity, timestamp: null,
      timestampText: body.slice(0, 15), timestampUncertainty: 'Year and timezone are not supplied by RFC3164.', hostname: host,
      appName: tag?.[1] || null, procId: tag?.[2] || null, message: tag ? tag[3] : message };
  } catch {
    return { protocol: 'syslog', format: 'unparsed', parseStatus: 'invalid', timestamp: null, timestampText: null, message: text, reason: 'Unrecognized or malformed syslog message.' };
  }
}

class Ber {
  constructor(bytes) { this.bytes = bytes; this.at = 0; }
  read(expected) {
    if (this.at + 2 > this.bytes.length) malformed();
    const tag = this.bytes[this.at++]; if ((tag & 31) === 31) malformed();
    let length = this.bytes[this.at++];
    if (length & 128) {
      const octets = length & 127; if (!octets || octets > 2 || this.at + octets > this.bytes.length) malformed();
      length = 0; for (let i = 0; i < octets; i++) length = length * 256 + this.bytes[this.at++];
    }
    if (this.at + length > this.bytes.length || (expected !== undefined && tag !== expected)) malformed();
    const value = this.bytes.subarray(this.at, this.at + length); this.at += length; return { tag, value };
  }
  done() { if (this.at !== this.bytes.length) malformed(); }
}
function integer(value, signed = true, bits = 32) {
  if (!value.length || value.length > Math.ceil(bits / 8) + 1 || (!signed && (value[0] & 128))) malformed();
  let result = 0n; for (const byte of value) result = result * 256n + BigInt(byte);
  if (signed && (value[0] & 128)) result -= 1n << BigInt(value.length * 8);
  const minimum = signed ? -(1n << BigInt(bits - 1)) : 0n, maximum = (1n << BigInt(bits - (signed ? 1 : 0))) - 1n;
  if (result < minimum || result > maximum) malformed();
  return bits === 64 ? result.toString() : Number(result);
}
function oid(value) {
  if (!value.length) malformed(); const parts = []; let arc = 0n, ended = true, length = 0;
  for (const byte of value) {
    arc = arc * 128n + BigInt(byte & 127); ended = !(byte & 128); length++;
    if (length > 5 || arc > 4294967375n) malformed();
    if (ended) { parts.push(arc); arc = 0n; length = 0; if (parts.length > 127) malformed(); }
  }
  if (!ended) malformed();
  const first = parts.shift(), branch = first < 40n ? 0n : first < 80n ? 1n : 2n;
  const all = [branch, first - branch * 40n, ...parts]; if (all.some(part => part > 4294967295n)) malformed();
  return all.map(String).join('.');
}
function octetText(value) {
  try {
    const text = utf8.decode(value);
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return { value: null, byteLength: value.length, omitted: 'Binary octet string' };
    return { value: text.slice(0, 2048), byteLength: value.length, truncated: text.length > 2048 };
  } catch { return { value: null, byteLength: value.length, omitted: 'Binary octet string' }; }
}
function varbinds(bytes) {
  const list = new Ber(bytes), result = [];
  while (list.at < bytes.length) {
    if (result.length >= MAX_VARBINDS) malformed();
    const item = new Ber(list.read(0x30).value), name = oid(item.read(6).value), { tag, value } = item.read(); item.done();
    let decoded;
    if (tag === 2) decoded = { type: 'Integer32', value: integer(value) };
    else if (tag === 4) decoded = { type: 'OctetString', ...octetText(value) };
    else if (tag === 6) decoded = { type: 'ObjectIdentifier', value: oid(value) };
    else if (tag === 5 || [0x80, 0x81, 0x82].includes(tag)) { if (value.length) malformed(); decoded = { type: ({ 5: 'Null', 128: 'noSuchObject', 129: 'noSuchInstance', 130: 'endOfMibView' })[tag], value: null }; }
    else if (tag === 0x40) { if (value.length !== 4) malformed(); decoded = { type: 'IpAddress', value: [...value].join('.') }; }
    else if ([0x41, 0x42, 0x43, 0x46].includes(tag)) decoded = { type: ({ 65: 'Counter32', 66: 'Gauge32', 67: 'TimeTicks', 70: 'Counter64' })[tag], value: integer(value, false, tag === 0x46 ? 64 : 32) };
    else if (tag === 0x44) decoded = { type: 'Opaque', value: null, byteLength: value.length, omitted: 'Opaque content' };
    else malformed();
    result.push({ oid: name, ...decoded });
  }
  return result;
}

function parseSnmp(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_DATAGRAM_BYTES) throw new TypeError('Expected a bounded event datagram');
  const unsupported = message => ({ protocol: 'snmp', format: 'unsupported', parseStatus: 'unsupported', timestamp: null, message });
  try {
    const outer = new Ber(bytes), message = new Ber(outer.read(0x30).value); outer.done();
    const version = integer(message.read(2).value);
    if (version === 3) return unsupported('SNMPv3 traps are not supported; no response was sent.');
    if (version !== 0 && version !== 1) return unsupported('Unsupported SNMP version; no response was sent.');
    message.read(4); // Community is deliberately discarded without decoding or retaining it.
    const pdu = message.read(); message.done();
    if (pdu.tag === 0xa6) return unsupported('SNMP informs are not supported or acknowledged.');
    if (pdu.tag !== (version === 0 ? 0xa4 : 0xa7)) return unsupported('Only SNMPv1 and SNMPv2c trap PDUs are supported; no response was sent.');
    const fields = new Ber(pdu.value); let trap;
    if (version === 0) {
      const enterpriseOid = oid(fields.read(6).value), address = fields.read(0x40).value;
      if (address.length !== 4) malformed();
      const genericTrap = integer(fields.read(2).value), specificTrap = integer(fields.read(2).value), uptimeTicks = integer(fields.read(0x43).value, false);
      if (genericTrap < 0 || genericTrap > 6 || specificTrap < 0) malformed();
      const variables = varbinds(fields.read(0x30).value); fields.done();
      trap = { version: '1', enterpriseOid, agentAddress: [...address].join('.'), genericTrap, specificTrap, uptimeTicks, variables,
        trapOid: genericTrap === 6 ? enterpriseOid + '.0.' + specificTrap : '1.3.6.1.6.3.1.1.5.' + (genericTrap + 1), trapOidSource: 'derived-from-v1-fields' };
    } else {
      const requestId = integer(fields.read(2).value), status = integer(fields.read(2).value), index = integer(fields.read(2).value);
      if (status !== 0 || index !== 0) malformed();
      const variables = varbinds(fields.read(0x30).value); fields.done();
      if (variables[0]?.oid !== '1.3.6.1.2.1.1.3.0' || variables[0]?.type !== 'TimeTicks' || variables[1]?.oid !== '1.3.6.1.6.3.1.1.4.1.0' || variables[1]?.type !== 'ObjectIdentifier') malformed();
      trap = { version: '2c', requestId, uptimeTicks: variables[0].value, trapOid: variables[1].value, trapOidSource: 'varbind', variables };
    }
    return { protocol: 'snmp', format: 'snmp' + trap.version, parseStatus: 'parsed', timestamp: null, message: 'SNMP trap ' + trap.trapOid, snmp: trap };
  } catch {
    // Never include packet bytes, parser exception strings, or partially
    // decoded envelopes: malformed messages can contain community credentials.
    return { protocol: 'snmp', format: 'unparsed', parseStatus: 'invalid', timestamp: null, message: 'Malformed or over-complex SNMP trap; packet contents were not retained.' };
  }
}

module.exports = { MAX_DATAGRAM_BYTES, MAX_VARBINDS, parseSyslog, parseSnmp };
