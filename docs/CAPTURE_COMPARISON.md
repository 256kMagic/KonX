# Capture comparison

Available from KonX 0.13.0. Compare a working capture with a failing capture using observed DNS, TCP, and plaintext HTTP/1 behavior, with links back to the packets behind each result.

## Compare two observations

Open **Network Tools → Capture Comparison**. Under **Before / working** and **After / failing**, use **Open file** or **Use open capture**, then **Compare captures**. Existing capture tabs must be stopped before selection. **Load demo comparison** loads and compares a synthetic working/failing pair without collecting traffic.

Each side keeps its own timestamps and source coverage. KonX compares durations within a transaction; it does not align the clocks of captures taken at different times. The comparison retains the selected packet snapshot, so source-frame links refer to the evidence used for that result.

Review the matched services, changed values, unchanged observations, unknowns, and unmatched services. Filter by service, category or result, then select a row to inspect its before and after values. **Frame** buttons open the retained capture on the correct side with that packet selected; **Open retained source** opens the entire retained selection. **Export comparison JSON** saves the report, or use **Add to incident**. A report contains bounded observations and source references, not embedded packet payloads; retain the captures separately when sharing an investigation.

## What is measured

- **DNS:** observed answers, response codes, transaction counts, and response time for uniquely paired, single-question UDP DNS transactions.
- **TCP:** SYN-to-SYN-ACK setup time, observed resets, and duplicate sequence-range candidates.
- **HTTP:** observed plaintext HTTP/1 status codes and time from the first request byte to the first response byte, using KonX's existing stream reassembly and message framing.

A duplicate TCP sequence range is a retransmission candidate, not proof of packet loss. Duplicate capture records, reordering, and capture location can produce similar evidence. An unobserved reply remains unknown; it does not establish that the service failed.

TLS application content, HTTP/2, HTTP/3, encrypted DNS, and DNS over TCP are outside these comparisons. Fragmented, malformed, truncated, or limited traffic keeps the affected conclusions provisional.

## Service identity

Automatic matching uses transport, client IP, server IP, and server port. Client ephemeral ports can differ between captures. If the same service moved to a different address, expand **Service identity and explicit mappings**, choose its before and after identities and select **Add explicit pair**. KonX records different-identity pairing as your choice and compares again. Each identity can have one explicit pair; **Remove pair** returns it to automatic matching. Ambiguous orientation and unmatched services stay visible rather than becoming removals or faults.

## Coverage and limits

File import accepts PCAP/PCAPNG files up to 64 MiB. Analysis examines up to 50,000 packets and 64 MiB of retained packet bytes on each side, with bounded flows, HTTP parsing, metrics, and source references. Larger open captures retain a bounded prefix and disclose omitted packets. **Coverage, limitations and unmatched observations** shows examined coverage, unknown timestamps, malformed/truncated traffic and any limit reached. A limited comparison cannot establish complete equality or a unique root cause.

PCAP/PCAPNG import reports incomplete records and read limits. PCAPNG interface timestamp offsets are applied before measuring a duration. Simple Packet Blocks have no timestamp; KonX preserves that uncertainty through viewing and export instead of inventing a capture time. Unsafe timestamp ranges remain unknown, and mixed known/unknown timing samples make the corresponding comparison provisional.

Capture export reports an error for known negative timestamps or an unknown-time packet with zero captured bytes but a nonzero original length, which the current writer cannot represent faithfully. Keep the original files when you need those representations or evidence beyond the retained analysis limits.

The SIP/RTP views also retain missing capture-time uncertainty: call timing, arrival jitter, and two-direction alignment need usable capture times. A supported mono audio stream can still be reconstructed from its RTP media clock.

The demo and automated tests use synthetic traffic. Real production captures can contain unsupported protocols and capture artifacts; inspect source packets and the coverage notes before drawing conclusions.
