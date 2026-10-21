# RTP media and audio

Available from KonX 0.9.0 in **Packet Capture → RTP Media**, or from a selected SIP call's **RTP Media** button.

## Try the demo

Open an empty Packet Capture tab, choose **RTP Media**, and load the synthetic demo. It contains one SIP call, two four-second G.711 tone streams, deliberate sequence gaps, a late packet, a duplicate, and an RTCP receiver report. No speech or real user's traffic is included. The demo replaces the capture in that tab; save existing packets first.

## Inspect a call

1. Open a PCAP or PCAPNG containing SIP/SDP and media.
2. Open **SIP Calls**, select the call, then choose **RTP Media**. You can also open all media from the packet toolbar.
3. Select a directional stream to inspect endpoints, SSRC, codec, sequence gaps, duplicates, reordering, and interarrival jitter.
4. Click a source packet in the table or jitter plot to return to its original frame. The display filter is cleared only when it hides that frame.
5. Use the call filter to compare the directions associated with a captured SIP declaration. Return to the SIP ladder to inspect the signaling.

Identification normally uses SDP endpoints and payload mappings. **Find possible RTP without SDP** enables heuristic candidates and requires a separate explicit acceptance before interpreting their bytes as audio. A plausible header does not prove a UDP flow is RTP. Conflicting codec declarations stay unknown.

## Play and export audio

For unencrypted mono PCMU or PCMA at 8 kHz, build the waveform, then choose playback or WAV export. Playback starts only on request and stops when the dialog closes or its capture is replaced. WAV files contain PCM16 mono audio.

Missing intervals become marked silence. They are not recovered speech. Reconstruction rejects conflicting sequence data, overlapping timestamps, sequence restarts, unknown codecs, gaps over ten seconds, and audio beyond ten minutes. The waveform and warnings identify inserted silence and other coverage limits.

When an unambiguous opposite-direction stream belongs to the same advertised call, paired playback aligns the streams using capture timestamps. This is an aid to reviewing the conversation; it does not synchronize sender clocks or emulate a receiver's jitter buffer. Each direction is exported separately.

## Interpret results

Sequence gaps describe missing observations in this capture. They do not prove network loss. A missing direction does not prove one-way audio: capture position, dropped capture packets, or incomplete signaling may hide it.

Jitter is calculated from captured arrival times and a known RTP clock rate. Unknown clocks produce unknown jitter. RTCP SR/RR details preserve their reported counters; RTCP jitter remains in RTP timestamp units. KonX does not invent MOS, end-to-end delay, RTT, or the listener's experience from incomplete evidence.

SRTP-advertised endpoints are excluded. Encrypted audio, codecs other than G.711, SIP over TLS, and media absent from the capture cannot be reconstructed by this feature.

Analysis is bounded to 200,000 examined packets, 128 streams, 100,000 retained media packets, and 32 MiB of media payload. Reaching a limit is visible. The source capture remains available for independent inspection and export.
