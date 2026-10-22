# Cisco terminal highlighting

Available in KonX 0.16.0. Common Cisco output receives automatic colors so errors, interface states, and addresses are easier to scan. Highlighting works in terminal tabs, including SSH, Telnet, raw TCP, and serial.

## What the colors mean

| Output | Color | Examples |
| --- | --- | --- |
| Cisco errors and severe syslog messages | Red | `% Invalid input detected`, `% Incomplete command`, nonzero input/output error counters, severity 0–3 messages |
| Cisco warning messages | Amber | Severity 4 syslog messages |
| Interface up or connected states | Green | `GigabitEthernet0/1 is up`, `line protocol is up`, a connected switch port |
| Interface down or disabled states | Red | `down`, `administratively down`, `notconnect` in recognized interface output |
| Valid IPv4 and IPv6 addresses | Blue | `192.0.2.10`, `2001:db8::1` |

On a mixed line such as `GigabitEthernet0/1 is up, line protocol is down`, each state gets its own color. Error and warning message colors take priority over addresses or states inside those messages. Plain words such as `backup`, uptime text, and zero-error counters do not become failures just because they contain a matching substring.

These are pattern-based display cues. Unrecognized text remains unchanged, and a color does not establish a device's overall health or the cause of a fault.

## Turn highlighting on or off

- **Current console:** click **Cisco colors** above the terminal. Its On/Off state applies to that tab, including its existing visible output. This temporary choice lasts while the tab remains open.
- **Global default:** choose **Settings → Appearance → Output highlighting → Cisco network output** or **Off**, then save. Cisco highlighting is enabled by default, including on profiles that do not yet have a preference.
- **Saved session:** open **Edit → Terminal & Log → Output highlighting** and choose **Use default**, **Cisco network output**, or **Off**. Reopen the session to use its saved override. An explicit session choice takes priority over the global default.

Highlight colors adapt to light and dark terminal backgrounds and remain distinct when using a monochrome terminal palette. Application themes, terminal palettes, and highlighting are independently selectable.

## Original output and remote colors

KonX adds display decorations after the terminal has interpreted incoming output. It does not insert color escape sequences into the received data. Clipboard selections, scrollback exports, terminal behavior, and text-file logs retain their original text. Output already colored by the remote device keeps those colors.

Highlighting follows visible normal-screen output as it arrives, wraps, scrolls, resizes, or is rewritten. Full-screen applications using the alternate screen keep their own presentation. Work is limited to visible output and bounded wrapped-line context rather than scanning the entire scrollback on every update; unusually long lines may be left unhighlighted.

## Trying it

On an authorized Cisco connection, run `show ip interface brief`, `show interfaces`, or `show interfaces status` where supported by the device. Compare the same output with **Cisco colors** On and Off. The output text should stay identical while recognized states and addresses change appearance.

See [Terminal workflow](USER_GUIDE.md#terminal-workflow), [Session logging](USER_GUIDE.md#session-logging), and the [release notes](releases/0.16.0.md) for validation scope.

Recognized interface patterns follow examples in Cisco's [interface command reference](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/interface/command/ir-cr-book/ir-s4.html) and [IP interface reference](https://www.cisco.com/E-Learning/bulk/public/tac/cim/cib/using_cisco_ios_software/cmdrefs/show_ip_interface.htm). Message colors use Cisco's [syslog severity levels](https://docs.manage.security.cisco.com/c-message-severity-levels.html).
