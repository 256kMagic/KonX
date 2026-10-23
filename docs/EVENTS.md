# Live Events

Live Events receives UDP syslog messages and SNMP traps on this computer and turns
them into a readable event list. It starts only when you press **Start listening**.
Opening KonX, opening this tool, or loading a saved workspace does not start a
listener, poll a device, or connect a terminal.

## Start and inspect traffic

1. Open **Network Tools → Live Events**.
2. Choose **Syslog** or **SNMP traps**. The defaults are `127.0.0.1:5514` for
   syslog and `127.0.0.1:5162` for SNMP traps.
3. Enter a numeric **Local bind address** assigned to this computer and a
   **UDP port** from 1 to 65535. Loopback (`127.0.0.1` or `::1`) receives only
   locally sent traffic. For a network device, use this computer's appropriate
   network address, permit incoming traffic through its firewall, and configure
   the device to send to that address and port. KonX does not configure the device.
4. Press **Start listening**. Wait for the status to say **Listening**. A bind
   error can mean the address is not local, the port is already in use, or the
   operating system denied access.
5. Filter by text, exact source IP, protocol or syslog severity. Click a row to
   inspect readable fields, structured data, or SNMP OIDs and varbind values.
   Use **Previous** and **Next** to page through matching records.

**Received** is the local receive time. **Reported time** is the sender's timestamp.
They remain separate. Traditional RFC3164 syslog supplies neither a year nor a
timezone, so KonX retains its source text and leaves absolute reported time unknown.
SNMP uptime ticks are also not an absolute date/time. A source address, hostname or
trap value is an observation, not proof of the sending device's identity.

## Link a device, preserve evidence and export

Select a row to check for a unique saved session whose host exactly matches the
source IP. KonX does not resolve hostnames or choose between ambiguous matches.
**Open existing terminal** activates a connected terminal only when its saved
session reference and connected host match. **Prepare saved session** opens the
session editor for your review. Neither action silently creates a connection;
connecting from the editor remains an explicit choice.

Use the row checkboxes to select evidence, then **Add selected to incident**.
The incident tool receives a pending report containing only the selected retained
records. Choose an incident and explicitly add the pending evidence there. The
selection is limited to 256 KiB; select fewer events or export a file when larger.

**Export filtered JSON** and **Export filtered text** take a snapshot of the
currently loaded, matching history. Review the confirmation, then choose a file.
Exports include message text, source addresses, hostnames and decoded SNMP values.
SNMP community bytes are omitted, but other fields may contain private data.
**Explain summary** prepares counts and limitations in AI & Knowledge, excluding
event text, addresses, hostnames and varbinds. Sending an AI question remains an
explicit action in that tool.

## Stop, clear and reopen history

**Stop** closes this listener and waits for confirmed socket cleanup. Other
listeners remain running. Closing a running Live Events tab also waits for its
listener to stop. If cleanup cannot be confirmed, the panel stays open and offers
Stop again; KonX retains ownership for shutdown/update cleanup.

**Clear history** removes retained rows and queued display rows while reception
continues. It does not reset sequence numbers or cumulative counters. **Refresh
history** reloads the bounded backend history, including records that were omitted
from a full display batch.

Use **Retained event listener history → Load stopped history** to reopen a stopped
listener's records without starting it. Starting that listener again preserves its
bounded history and counters. **Remove stopped history** releases an unused history
slot. To change a retained listener's protocol, remove that stopped history or open
a new Live Events tab. History exists in memory during this KonX run and is lost
when the application exits; export or add evidence to an incident to retain it.

## Formats and coverage

- Syslog: RFC5424 version 1 headers and structured data, plus the common RFC3164
  header/tag form. Unsupported or malformed messages remain bounded literal text.
  Invalid UTF-8 uses replacement characters and is marked invalid. RFC5424 offsets
  and fractional timestamp precision are preserved. Message encoding without a
  UTF-8 BOM is identified as unspecified and decoded as UTF-8 for display.
- SNMP: v1 and v2c trap PDUs only. Numeric OIDs and integer, counter, ticks,
  address, textual octet-string and exception values are decoded. Counter64 is
  retained as a decimal string to preserve precision. Text values are capped at
  2,048 characters with a truncation flag. Binary/opaque values show their type
  and length without raw content. A v1 trap OID is labeled as derived from its
  generic/specific fields; v2c uses the supplied trap OID.
- Community strings are discarded without decoding. Raw SNMP packets and hex dumps
  never enter history or errors. SNMPv3 and informs show unsupported notices;
  informs receive no acknowledgement. Malformed or excessive BER shows a generic
  notice without partially decoded packet contents. There are no MIB lookups,
  outbound requests, DNS resolution or response packets.

## Bounds and counters

KonX permits four simultaneous listeners and eight retained listener histories.
Each history holds at most 1,000 records and 1 MiB of serialized record content;
the oldest records are evicted when either limit is reached. Datagrams larger than
8 KiB are dropped. Each listener examines at most 200 datagrams per second.

The interface receives batches every 100 ms, up to 100 records / 128 KiB per batch,
with a final bounded flush on close. Display omissions remain recoverable through
**Refresh history** while the records still fit in backend history. Details are
bounded to 64 SNMP varbinds, 128 OID components, definite BER lengths, and 32 syslog
structured-data elements with 64 parameters per element. A single serialized
record is limited to 64 KiB.

The counters distinguish received packets, accepted records, invalid or unsupported
records, oversized/rate/record drops, display omissions and history evictions.
They cover packets delivered to the application callback. UDP or operating-system
drops before that point cannot be counted. The receiver does not guarantee delivery
or complete coverage of all vendor extensions. IPv6 zone identifiers are not
supported in bind addresses.

Protocol references: [RFC5424](https://datatracker.ietf.org/doc/html/rfc5424),
[RFC3164](https://datatracker.ietf.org/doc/html/rfc3164),
[RFC1157](https://www.rfc-editor.org/rfc/rfc1157.html),
[RFC3416](https://datatracker.ietf.org/doc/html/rfc3416), and
[RFC3584](https://datatracker.ietf.org/doc/html/rfc3584).
