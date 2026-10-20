import assert from 'node:assert/strict';
import { parseSdp, SDP_LIMITS } from '../src/renderer/js/capture/sdp.mjs';

const base = 'v=0\r\no=- 12345 2 IN IP4 192.0.2.1\r\ns=Example call\r\nc=IN IP4 192.0.2.10\r\nt=0 0\r\n';

export async function runSdpTests(test) {
  await test('SDP session connection and direction inherit only within their session', () => {
    const parsed = parseSdp(base + 'a=recvonly\r\nm=audio 5004 RTP/AVP 0 8\r\nm=video 6000 RTP/AVP 96\r\nc=IN IP6 2001:db8::20\r\na=sendonly\r\na=rtpmap:96 H264/90000\r\n');
    assert.equal(parsed.complete, true, parsed.warnings.join('\n'));
    assert.equal(parsed.sessionName, 'Example call');
    assert.equal(parsed.origin, '- 12345 2 IN IP4 192.0.2.1');
    assert.deepEqual(parsed.timing, { start: '0', stop: '0', raw: '0 0' });
    assert.equal(parsed.direction, 'recvonly');
    const [audio, video] = parsed.media;
    assert.equal(audio.connection.address, '192.0.2.10');
    assert.equal(audio.connectionSource, 'session');
    assert.equal(audio.direction, 'recvonly');
    assert.equal(audio.directionSource, 'session');
    assert.equal(video.connection.address, '2001:db8::20');
    assert.equal(video.connection.addressType, 'IP6');
    assert.equal(video.connectionSource, 'media');
    assert.equal(video.direction, 'sendonly');
    assert.equal(video.directionSource, 'media');
    assert.deepEqual(audio.codecs.map(({ payloadType, name, clockRate, channels, mappingSource }) => ({ payloadType, name, clockRate, channels, mappingSource })), [
      { payloadType: '0', name: 'PCMU', clockRate: 8000, channels: 1, mappingSource: 'static' },
      { payloadType: '8', name: 'PCMA', clockRate: 8000, channels: 1, mappingSource: 'static' },
    ]);
    assert.equal(video.codecs[0].channels, null);
  });

  await test('SDP default sendrecv and port-zero disabling remain separate facts', () => {
    const parsed = parseSdp(base + 'm=audio 0 RTP/AVP 0\r\nm=audio 49170/2 RTP/AVP 8\r\n');
    assert.equal(parsed.complete, true);
    assert.equal(parsed.directionSource, 'default');
    assert.equal(parsed.media[0].disabled, true);
    assert.equal(parsed.media[0].direction, 'sendrecv');
    assert.equal(parsed.media[0].directionSource, 'default');
    assert.equal(parsed.media[1].portCount, 2);
    assert.equal(parsed.media[1].disabled, false);
    assert.equal(parsed.media[1].rtcp, null, 'RTCP endpoint is not fabricated from the RTP port');
  });

  await test('SDP media-only IPv6 connections never leak to later media', () => {
    const parsed = parseSdp(base.replace('c=IN IP4 192.0.2.10\r\n', '') + 'm=audio 5004 RTP/AVP 0\r\nc=IN IP6 2001:db8::1\r\na=inactive\r\nm=audio 5006 RTP/AVP 8\r\n');
    assert.equal(parsed.connection, null);
    assert.equal(parsed.media[0].connection.address, '2001:db8::1');
    assert.equal(parsed.media[1].connection, null);
    assert.equal(parsed.media[1].connectionSource, null);
    assert.equal(parsed.media[1].direction, 'sendrecv');
    assert.equal(parsed.complete, false);
  });

  await test('SDP dynamic codec declarations and fmtp preserve exact parameters', () => {
    const parameters = 'minptime=10; useinbandfec=1; vendor="a:b"  ';
    const parsed = parseSdp(base + 'm=audio 5004 UDP/TLS/RTP/SAVPF 111 101\r\na=fmtp:111 ' + parameters + '\r\na=rtpmap:111 opus/48000/2\r\na=rtpmap:101 telephone-event/8000\r\na=fmtp:101 0-16\r\n');
    assert.equal(parsed.complete, true, parsed.warnings.join('\n'));
    const [opus, events] = parsed.media[0].codecs;
    assert.equal(opus.name, 'opus');
    assert.equal(opus.clockRate, 48000);
    assert.equal(opus.channels, 2);
    assert.equal(opus.fmtp, parameters);
    assert.equal(opus.mappingSource, 'rtpmap');
    assert.equal(events.channels, 1);
    assert.equal(parsed.media[0].attributes[0].value, '111 ' + parameters);
  });

  await test('SDP unmapped dynamic payload IDs do not imply a codec', () => {
    const parsed = parseSdp(base + 'm=audio 5004 RTP/AVP 111\r\na=fmtp:111 minptime=10\r\n');
    assert.deepEqual(parsed.media[0].codecs[0], { payloadType: '111', name: null, clockRate: null, channels: null, fmtp: 'minptime=10', mappingSource: null });
    assert.match(parsed.warnings.join(' '), /codec is unknown/);
    const otherProfile = parseSdp(base + 'm=audio 5004 RTP/OTHER 0\r\n');
    assert.equal(otherProfile.media[0].codecs[0].name, null, 'static mapping is restricted to the verified profile');
  });

  await test('SDP explicit RTCP preserves IPv6 and absent address without inventing endpoints', () => {
    const parsed = parseSdp(base + 'm=audio 5004 RTP/AVP 0\r\na=rtcp:53020 IN IP6 2001:db8::99\r\nm=audio 6000 RTP/AVP 8\r\na=rtcp:6001\r\n');
    assert.equal(parsed.complete, true);
    assert.deepEqual(parsed.media[0].rtcp, { port: 53020, connection: { networkType: 'IN', addressType: 'IP6', address: '2001:db8::99', raw: 'IN IP6 2001:db8::99' }, raw: '53020 IN IP6 2001:db8::99' });
    assert.deepEqual(parsed.media[1].rtcp, { port: 6001, connection: null, raw: '6001' });
  });

  await test('SDP unknown attributes and unmodeled lines retain their original values', () => {
    const text = base + 'a=X-Vendor:  exact : value  \r\na=extmap:1 urn:example:extension\r\ni=Unmodeled information\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=sctp-port:5000\r\n';
    const parsed = parseSdp(text);
    assert.equal(parsed.rawText, text);
    assert.equal(parsed.attributes[0].name, 'X-Vendor');
    assert.equal(parsed.attributes[0].value, '  exact : value  ');
    assert.equal(parsed.unknownLines[0].raw, 'i=Unmodeled information');
    assert.deepEqual(parsed.media[0].formats, ['webrtc-datachannel']);
    assert.deepEqual(parsed.media[0].codecs, []);
    assert.equal(parsed.media[0].attributes[0].value, '5000');
    const unknown = parseSdp(base + 'x=vendor field\r\n');
    assert.equal(unknown.unknownLines[0].value, 'vendor field');
    assert.equal(unknown.complete, false);
  });

  await test('SDP malformed media and attributes keep partial facts and explicit uncertainty', () => {
    const parsed = parseSdp(base + 'm=audio nope RTP/AVP 111\r\nc=IN IP6\r\na=rtpmap:111 opus/nope\r\na=rtcp:70000\r\na=sendonly\r\na=recvonly\r\n');
    assert.equal(parsed.complete, false);
    const media = parsed.media[0];
    assert.equal(media.port, null);
    assert.equal(media.connection, null, 'malformed media override must not fall back to session connection');
    assert.equal(media.connectionSource, 'media');
    assert.equal(media.direction, null);
    assert.equal(media.codecs[0].name, null);
    assert.equal(media.rtcp, null);
    assert.ok(parsed.warnings.length >= 5);
    for (const value of [null, undefined, 123, {}, 'not SDP', 'v=0\r\ns=\r\nt=bad\r\n']) {
      assert.doesNotThrow(() => parseSdp(value));
      assert.equal(parseSdp(value).complete, false);
    }
  });

  await test('SDP conflicting or malformed codec redeclarations never silently select a codec', () => {
    for (const declarations of ['a=rtpmap:111 opus/48000/2\r\na=rtpmap:111 telephone-event/8000\r\n', 'a=rtpmap:111 opus/48000/2\r\na=rtpmap:111 malformed\r\n']) {
      const parsed = parseSdp(base + 'm=audio 5004 RTP/AVP 111\r\n' + declarations);
      assert.equal(parsed.media[0].codecs[0].name, null);
      assert.equal(parsed.complete, false);
    }
    const invalidStatic = parseSdp(base + 'm=audio 5004 RTP/AVP 0\r\na=rtpmap:0 malformed\r\n');
    assert.equal(invalidStatic.media[0].codecs[0].name, null);
  });

  await test('SDP LF lines, timing precision and multiple schedules are preserved', () => {
    const parsed = parseSdp(base.replaceAll('\r\n', '\n') + 't=18446744073709551615 18446744073709551616\nr=7d 1h 0\n');
    assert.equal(parsed.complete, true);
    assert.equal(parsed.timings.length, 2);
    assert.equal(parsed.timings[1].start, '18446744073709551615');
    assert.equal(parsed.unknownLines[0].value, '7d 1h 0');
  });

  await test('SDP resource limits expose partial parsing instead of silent completeness', () => {
    const media = parseSdp(base + 'm=audio 5004 RTP/AVP 0\r\n'.repeat(SDP_LIMITS.maxMedia + 1));
    assert.equal(media.media.length, SDP_LIMITS.maxMedia);
    assert.equal(media.complete, false);
    assert.match(media.warnings.join(' '), /media limit/);
    const lines = parseSdp(base + 'a=unknown\n'.repeat(SDP_LIMITS.maxLines + 1));
    assert.equal(lines.complete, false);
    assert.match(lines.warnings.join(' '), /line limit/);
    const long = parseSdp(base + 'a=vendor:' + 'x'.repeat(SDP_LIMITS.maxLineChars));
    assert.equal(long.complete, false);
    assert.match(long.warnings.join(' '), /line size limit/);
    const body = parseSdp(base + ('a=vendor:' + 'x'.repeat(240) + '\n').repeat(1100));
    assert.equal(body.rawText.length, SDP_LIMITS.maxChars);
    assert.equal(body.complete, false);
    assert.match(body.warnings.join(' '), /text limit/);
  });
}
