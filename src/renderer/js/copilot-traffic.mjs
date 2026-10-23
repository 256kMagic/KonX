import { EvidenceContext, TRAFFIC_COPILOT_KINDS } from './copilot-context.mjs';

export { TRAFFIC_COPILOT_KINDS };
const CAPTURE_KINDS = TRAFFIC_COPILOT_KINDS.slice(0, 4);
const CAPTURE_TITLES = ['Packet fields', 'Readable stream', 'SIP call', 'RTP stream quality'];
const pick = (value, fields) => Object.fromEntries(fields.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const selected = table => table?.rows?.filter(row => table.selected.has(table.rowKey(row))) || [];
const limits = report => [...(report?.limitations || []), ...(report?.warnings || []).map(item => typeof item === 'string' ? item : item.message || item.reason || 'A source warning is present.')];
function* rows(values, project = value => value) { let index = 0; for (const value of values) { const fact = project(value); yield { fact: { ...fact, ...(fact.id === undefined ? {} : { sourceId: fact.id }), id: `row:${++index}` }, selected: true }; } }
const noRaw = 'Binary packet bytes, audio, authentication headers, credential controls, raw configuration inputs and unparsed protocol bodies are not attached.';

/** A producer owns revisions; capture only projects its retained parsed models. */
export class TrafficEvidenceOwner {
  constructor(tab, kind = tab.toolKind || tab.kind) {
    this.tab = tab; this.kind = kind; this.report = null; this.availability = null;
    this.contexts = new Map((kind === 'capture' ? CAPTURE_KINDS : [kind]).map(name => [name,
      new EvidenceContext(name, tab.id, CAPTURE_TITLES[CAPTURE_KINDS.indexOf(name)] || tab.title)]));
  }
  get first() { return this.contexts.values().next().value; }
  get revision() { return this.first.revision; }
  get runId() { return this.first.runId; }
  notify() { this.tab.app.copilot?.sourceChanged(this.tab); }
  begin(inputs, runId) { for (const context of this.contexts.values()) context.begin(inputs, runId); this.notify(); }
  touch() { for (const context of this.contexts.values()) context.touch(); this.notify(); }
  finish(state = 'complete') { for (const context of this.contexts.values()) context.finish(state); this.notify(); }
  acceptReport(report) {
    if (report === this.report) {
      if (report && this.availability !== report.captureUnavailable) { this.availability = report.captureUnavailable; this.touch(); }
      return;
    }
    this.report = report; this.availability = report?.captureUnavailable;
    const scope = pick(report, ['kind', 'title', 'target', 'scopeId', 'scannedAt', 'collectedAt', 'fetchedAt', 'action', 'region', 'scope', 'host', 'interface', 'filter', 'startedAt', 'finishedAt']);
    if (this.kind === 'mist') scope.scope = pick(report?.scope, ['orgId', 'siteId', 'mac', 'type', 'duration', 'start', 'end']);
    if (this.kind === 'capture-compare' && report) { scope.before = pick(report.before, ['label', 'coverage']); scope.after = pick(report.after, ['label', 'coverage']); }
    this.begin(scope); this.finish(report ? 'complete' : 'idle');
  }
  retain() {
    const retained = Object.create(TrafficEvidenceOwner.prototype);
    Object.assign(retained, this);
    // A modal analyzes a fixed packet snapshot. Freeze its producer identity now,
    // so later live packets cannot relabel historical modal evidence as current.
    retained.contexts = new Map([...this.contexts].map(([kind, context]) => [kind, Object.assign(Object.create(EvidenceContext.prototype), context, { onChange() {} })]));
    return retained;
  }
  capture(kind, descriptor, selection = false) {
    const sourceNotices = [...new Set(descriptor.omissions || [])];
    const notices = sourceNotices.filter(notice => typeof notice === 'string' && notice.length <= 2000 && !notice.includes('\0'));
    if (notices.length !== sourceNotices.length) notices.push('Additional source notices were omitted whole because they exceed the evidence text limit.');
    const omissions = notices.length > 20 ? [...notices.slice(0, 20), `${notices.length - 20} additional source notices remain in the source view.`] : notices;
    return this.contexts.get(kind).capture({ ...descriptor, omissions }, { mode: selection ? 'selected' : 'all' });
  }
}

const PACKET_FIELDS = `eth.src eth.dst eth.type vlan.id vlan.inner mpls.label arp.opcode arp.src.hw_mac arp.src.proto_ipv4 arp.dst.proto_ipv4 arp.isgratuitous ip.src ip.dst ip.ttl ip.proto ip.id ip.len ip.dscp ip.flags.df ip.flags.mf ip.frag_offset ip.checksum_bad ip.inner.src ip.inner.dst ipv6.src ipv6.dst ipv6.hlim ipv6.nxt icmp.type icmp.code icmp.ident icmp.seq icmpv6.type icmpv6.code icmpv6.nd.target tcp.srcport tcp.dstport tcp.seq_raw tcp.ack_raw tcp.len tcp.window_size_value tcp.flags tcp.flags.syn tcp.flags.ack tcp.flags.fin tcp.flags.reset tcp.flags.push tcp.flags.urg tcp.options.mss udp.srcport udp.dstport udp.length dns.id dns.flags.response dns.flags.rcode dns.qry.name dns.qry.type http.request.method http.response.code tls.handshake.type tls.handshake.extensions_server_name malformed`.split(' ');

export function packetContext(owner, packet, decoded, coverage) {
  if (!packet || !decoded) throw new Error('Select a decoded packet first.');
  const fact = { ...pick(packet, ['no', 'ts', 'timestampKnown', 'caplen', 'len', 'lt']), ...pick(decoded, ['src', 'dst', 'sport', 'dport', 'proto']), fields: pick(decoded.f, PACKET_FIELDS) };
  return owner.capture('capture-packet', { rows: rows([fact]), summary: { captureCoverage: coverage || null }, observed: owner.tab.packets.length, total: null, complete: false,
    omissions: [noRaw, 'Only the selected packet is attached. A single packet cannot establish complete stream or capture behavior.'] }, true);
}

const PUBLIC_HEADERS = new Set(['host', 'content-type', 'content-length', 'content-encoding', 'transfer-encoding', 'connection', 'server', 'user-agent', 'accept', 'accept-encoding', 'cache-control', 'date', 'location']);
export function streamContext(owner, stream, parsed) {
  if (!stream || !parsed) throw new Error('Wait for readable traffic analysis to complete.');
  const omissions = [noRaw, 'Only messages recognized by the existing readable-traffic parser are attached; unsupported application data remains unknown. Display search and paging do not limit this stream attachment.'];
  const messages = (parsed.messages || []).map(message => {
    const out = pick(message, ['type', 'fromA', 'startLine', 'method', 'target', 'status', 'reason', 'mediaType', 'bodyEncoding', 'framing', 'complete', 'frames', 'start', 'end', 'warnings']);
    out.headers = (message.headers || []).filter(header => PUBLIC_HEADERS.has(String(header.name).toLowerCase())).map(header => pick(header, ['name', 'value']));
    if (message.previewTruncated) omissions.push('A message body was omitted because the source decoder retained only a truncated text preview.');
    else if (typeof message.text === 'string') out.text = message.text;
    else omissions.push('Non-text, encrypted or unsupported message bodies are omitted.');
    return out;
  });
  return owner.capture('capture-stream', { rows: rows(messages), summary: { stream: pick(stream.conv, ['id', 'proto', 'a', 'b']),
    directions: (stream.directions || []).map(direction => ({ ...pick(direction, ['fromA', 'startKnown', 'endKnown', 'truncated', 'warnings']), conflictingRanges: direction.conflicts?.length ?? null, gaps: (direction.ranges || []).filter(range => range.kind !== 'data').map(range => pick(range, ['kind', 'start', 'end', 'length', 'reason', 'frames'])) })),
    recognized: parsed.recognized, warnings: [...(stream.warnings || []), ...(parsed.warnings || [])], truncated: parsed.truncated }, observed: messages.length, total: null, complete: false, omissions: [...new Set(omissions)] });
}

const connection = value => value ? pick(value, ['networkType', 'addressType', 'address']) : null;
const sdpFacts = value => value ? { ...pick(value, ['sessionName', 'direction', 'directionSource', 'complete', 'warnings']), timings: (value.timings || []).map(timing => pick(timing, ['start', 'stop'])), connection: connection(value.connection),
  media: (value.media || []).map(media => ({ ...pick(media, ['type', 'port', 'portCount', 'protocol', 'formats', 'disabled', 'connectionSource', 'direction', 'directionSource']), connection: connection(media.connection),
    codecs: (media.codecs || []).map(codec => pick(codec, ['payloadType', 'name', 'clockRate', 'channels', 'mappingSource'])) })) } : null;

export function sipContext(owner, call, analysis) {
  if (!call) throw new Error('Select a SIP call first.');
  return owner.capture('sip-call', { rows: rows(call.messages || [], message => ({ ...pick(message, ['type', 'src', 'dst', 'ts', 'frames', 'method', 'status', 'reason', 'cseq', 'retransmission', 'dialogId', 'transactionId', 'complete', 'warnings']), sdp: sdpFacts(message.sdp) })),
    summary: { call: pick(call, ['id', 'callId', 'from', 'to', 'frames', 'outcome', 'setupTime', 'duration', 'warnings']), analysis: pick(analysis, ['scannedPackets', 'limited', 'warnings']) }, observed: call.messages?.length || 0, total: call.messages?.length || 0, complete: false,
    omissions: [noRaw, 'Only the selected call is attached. SIP authentication headers, raw messages, SDP attributes, ICE passwords and media key material are excluded; codec format parameters are not attached.'] }, true);
}

export function rtpContext(owner, stream, analysis) {
  if (!stream) throw new Error('Select an RTP stream first.');
  return owner.capture('rtp-stream', { rows: rows(stream.packets || [], packet => pick(packet, ['frame', 'time', 'sequence', 'extendedSequence', 'epoch', 'timestamp', 'extendedTimestamp', 'payloadType', 'payloadBytes', 'headerBytes', 'marker', 'deltaMs', 'flags', 'jitterMs'])),
    summary: { stream: { ...pick(stream, ['id', 'src', 'dst', 'ssrc', 'packetCount', 'uniquePackets', 'durationSeconds', 'startTime', 'endTime', 'sequenceGaps', 'outOfOrderPackets', 'duplicatePackets', 'conflictingPackets', 'sequenceEpochs', 'clockRate', 'maxJitterMs', 'lastJitterMs', 'identification', 'incomplete', 'associations', 'warnings']), payloadTypes: (stream.payloadTypes || []).map(codec => pick(codec, ['payloadType', 'name', 'clockRate', 'channels', 'source', 'ambiguous'])) }, analysis: pick(analysis, ['scannedPackets', 'examinedBytes', 'excluded', 'warnings', 'limited']) },
    observed: stream.packets?.length || 0, total: stream.packetCount ?? null, complete: false,
    omissions: [noRaw, 'Only the selected directional RTP stream is attached. Timing, codec identification and sequence gaps retain the parser’s uncertainty; gaps are not proof of network loss.'] }, true);
}

export function trafficContextChoices(tab) {
  if (tab.disposed) return [];
  const report = tab.report, ready = Boolean(report);
  switch (tab.toolKind || tab.kind) {
    case 'capture': return [{ choice: 'selected-packet', label: 'Selected packet · decoded fields', disabled: !tab.packets?.[tab.selected] }];
    case 'capture-compare': return [{ choice: 'selected-change', label: 'Selected comparison observation', disabled: !ready || !tab.selectedChange }, { choice: 'comparison-summary', label: 'Comparison summary and coverage', disabled: !ready }];
    case 'remote-capture': return [{ choice: 'collection-report', label: 'Remote collection report · no packet file', disabled: !ready }];
    case 'security': return [{ choice: 'selected-check', label: 'Selected security check', disabled: !ready || !selected(tab.table).length }, { choice: 'assessment', label: 'Retained assessment checks', disabled: !ready }];
    case 'wifi': return [{ choice: 'selected-network', label: 'Selected Wi-Fi network', disabled: !ready || !selected(tab.networks).length }, { choice: 'selected-adapter', label: 'Selected wireless adapter', disabled: !ready || !selected(tab.adapters).length }, { choice: 'survey', label: 'Retained Wi-Fi survey', disabled: !ready }];
    case 'mist': return [{ choice: 'selected-entity', label: 'Selected Mist entity', disabled: !ready || !selected(tab.table).length }, { choice: 'report-summary', label: 'Mist report scope and coverage', disabled: !ready }];
    default: return [];
  }
}

const NETWORK = ['adapterId', 'bssid', 'ssid', 'hidden', 'band', 'channel', 'signalPercent', 'rssiDbm', 'authentication', 'encryption', 'groupEncryption', 'connected', 'radioType', 'frequencyMHz'];
const adapterFacts = row => ({ ...pick(row, ['id', 'name', 'description', 'state']), connection: row.connection ? pick(row.connection, [...NETWORK, 'rxMbps', 'txMbps']) : null });
const ENTITY = ['id', 'name', 'access', 'role', 'timezone', 'model', 'status', 'ip', 'mac', 'numClients', 'hostname', 'ssid', 'band', 'rssi', 'siteId', 'orgId', 'uptime', 'version', 'serial'];

export function captureTrafficContext(tab, { choice } = {}) {
  const option = trafficContextChoices(tab).find(item => item.choice === choice);
  if (!option || option.disabled) throw new Error('Choose available evidence in the source view before attaching it.');
  const owner = tab.copilot, report = tab.report, kind = tab.toolKind || tab.kind;
  if (kind === 'capture') return packetContext(owner, tab.packets[tab.selected], tab.selectedDecoded || tab.packets[tab.selected].d, tab.captureCoverage);
  let facts = [], summary = {}, omissions = [noRaw, ...limits(report)], isSelection = choice.startsWith('selected-'), observed = null;
  if (kind === 'security') {
    const checks = isSelection ? selected(tab.table) : report.checks;
    facts = checks.map(check => pick(check, ['id', 'title', 'status', 'severity', 'evidence', 'remediation', 'confidence', 'reference']));
    summary = pick(report, ['kind', 'title', 'target', 'scannedAt', 'scopeId']);
    observed = report.checks.length;
  } else if (kind === 'wifi') {
    facts = choice === 'selected-adapter' ? selected(tab.adapters).map(adapterFacts) : (choice === 'selected-network' ? selected(tab.networks) : report.networks).map(row => pick(row, NETWORK));
    summary = { collectedAt: report.collectedAt, ...(choice === 'survey' ? { adapters: report.adapters.map(adapterFacts), channels: report.channels.map(channel => pick(channel, ['band', 'channel', 'bssidCount', 'strongestRssiDbm'])), findings: report.findings.map(finding => pick(finding, ['id', 'title', 'status', 'evidence', 'remediation'])) } : {}) };
    omissions.push('Windows cached observations; BSSID counts are not measured airtime, interference or a complete radio survey.');
    observed = choice === 'selected-adapter' ? report.adapters.length : report.networks.length;
  } else if (kind === 'remote-capture') {
    facts = [pick(report, ['host', 'interface', 'filter', 'startedAt', 'finishedAt', 'packets', 'bytes', 'fileName', 'stopped', 'complete', 'remoteExitConfirmed', 'exitCode', 'exitSignal', 'captureUnavailable', 'captureId', 'warnings'])];
    omissions.push('Only collection state is attached. No retained capture file was read and stderr is excluded.');
    observed = 1;
  } else if (kind === 'capture-compare') {
    facts = isSelection ? [pick(tab.selectedChange, ['id', 'serviceId', 'category', 'metric', 'status', 'before', 'after', 'beforeSources', 'afterSources', 'beforeSourceCount', 'afterSourceCount', 'sourcesLimited', 'reason'])] : [];
    summary = { summary: report.summary, before: pick(report.before, ['label', 'coverage']), after: pick(report.after, ['label', 'coverage']) };
    if (isSelection) summary.service = pick(report.services.find(service => service.id === tab.selectedChange.serviceId), ['id', 'beforeServiceId', 'afterServiceId', 'identity', 'beforeIdentity', 'afterIdentity', 'status', 'warnings']);
    omissions.push('Capture identities and original frame references are retained. Unmatched or incomplete observations remain unknown; packet bytes and unrelated changes are omitted.');
    observed = report.changes.length;
  } else if (kind === 'mist') {
    summary = pick(report, ['action', 'region', 'fetchedAt', 'scope', 'limited']);
    summary.scope = pick(report.scope, ['orgId', 'siteId', 'mac', 'type', 'duration', 'start', 'end']);
    if ((report.limitations || []).some(line => line.includes('local text, record, or nesting limit'))) omissions.push('Entity fields were omitted because the cloud producer may have truncated text before this attachment.');
    else if (isSelection) facts = selected(tab.table).map(row => pick(row, ENTITY));
    omissions.push('Only selected allowlisted entity fields or report scope are attached. Tokens, configuration controls and arbitrary cloud response bodies are excluded.');
    observed = Array.isArray(report.data) ? report.data.length : report.action === 'self' ? report.data.orgs.length + report.data.sites.length : null;
  }
  return owner.capture(kind, { rows: rows(facts), summary, observed, total: null, complete: false, omissions: [...new Set(omissions)] }, isSelection);
}
