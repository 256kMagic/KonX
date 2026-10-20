// Loads the Monaco editor on first use and adds KonX languages and themes.
// Monaco 0.57 still ships its AMD build (deprecated upstream); if it is removed in a future
// version, switch to bundling the ESM build. Only this file knows how Monaco is loaded.

const BASE = new URL('../../../../node_modules/monaco-editor/min/vs', import.meta.url).href;
let loading = null;

export function loadMonaco() {
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `${BASE}/loader.js`;
    s.onload = () => {
      const req = window.require;
      req.config({ paths: { vs: BASE } });
      req(
        ['vs/editor/editor.main'],
        () => {
          try {
            setup(window.monaco);
            resolve(window.monaco);
          } catch (e) {
            reject(e);
          }
        },
        (err) => reject(new Error(`Could not load the editor: ${err && err.message}`))
      );
    };
    s.onerror = () => reject(new Error('Could not load the editor component'));
    document.head.append(s);
  });
  return loading;
}

const IFACE = /\b(?:GigabitEthernet|TenGigabitEthernet|TwentyFiveGigE|FortyGigabitEthernet|HundredGigE|FastEthernet|Ethernet|Port-channel|port-channel|Vlan|vlan|Loopback|loopback|Tunnel|Serial|BDI|mgmt|Gi|Te|Fa|Eth|Po|Lo|Tu|Hu|Fo|Twe|ge-|xe-|et-|ae)\d+(?:[/:]\d+)*(?:\.\d+)?\b/;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?\b/;
const MAC = /\b(?:[0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4}|(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2})\b/;

function setup(monaco) {
  // ---------------- Cisco IOS / IOS-XE / NX-OS style configuration
  monaco.languages.register({ id: 'ios', aliases: ['Cisco IOS config', 'Network config'], extensions: ['.ios'] });
  monaco.languages.setLanguageConfiguration('ios', {
    comments: { lineComment: '!' },
    autoClosingPairs: [{ open: '"', close: '"' }],
    indentationRules: { increaseIndentPattern: /^(interface|router|line|vlan|policy-map|class-map|route-map|ip access-list|object-group|crypto|vrf|key chain|aaa)\b/, decreaseIndentPattern: /^\s*!\s*$/ },
  });
  monaco.languages.setMonarchTokensProvider('ios', {
    ignoreCase: true,
    tokenizer: {
      root: [
        [/^\s*!.*$/, 'comment'],
        [/^(\s*)(description|remark|alias|banner \w+)(.*)$/, ['white', 'keyword.sub', 'string']],
        [/^(\s*)(no)(?=\s)/, ['white', 'keyword.no']],
        [/^(interface|router|line|vlan|vrf|policy-map|class-map|route-map|crypto|aaa|hostname|username|banner|access-list|object-group|object|track|key|spanning-tree|snmp-server|ntp|logging|archive|control-plane|redundancy|license|boot|service|version|end|ip|ipv6|feature|monitor|event|flow|zone|zone-pair|parameter-map|template|switch|mac|errdisable|vtp|cdp|lldp|clock|enable|tacacs|radius|management|system|set|security|policy|firewall)\b/, 'keyword.section'],
        [/\bshutdown\b/, 'keyword.no'],
        [/\bpermit\b/, 'keyword.permit'],
        [/\bdeny\b/, 'keyword.deny'],
        [MAC, 'number.mac'],
        [IPV4, 'number.ip'],
        [IFACE, 'type.interface'],
        [/\b(?:switchport|mode|access|trunk|allowed|native|encapsulation|dot1q|standby|vrrp|hsrp|ospf|eigrp|bgp|isis|neighbor|network|area|remote-as|redistribute|address|secondary|helper-address|nat|inside|outside|channel-group|portfast|bpduguard|speed|duplex|mtu|bandwidth|priority|preempt|secret|password|privilege|transport|input|output|ssh|telnet|exec-timeout|login|local|authentication|authorization|accounting|default|group|source|any|host|eq|neq|gt|lt|range|established|log|tcp|udp|icmp|route|prefix-list|match|set|community|vlan|voice|trust|qos|police|shape|class|ip|ipv6|unicast|multicast|vpn|tunnel|key-string|description)\b/, 'keyword.sub'],
        [/"[^"]*"/, 'string'],
        [/\b\d+\b/, 'number'],
      ],
    },
  });

  // ---------------- Log files (syslog, Cisco %FACILITY-SEV-MNEMONIC, app logs)
  monaco.languages.register({ id: 'log', aliases: ['Log file'], extensions: ['.log'] });
  monaco.languages.setMonarchTokensProvider('log', {
    tokenizer: {
      root: [
        [/^\S*\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z|[+-]\d\d:?\d\d)?/, 'date'],
        [/^\*?[A-Z][a-z]{2}\s+\d{1,2}\s+(?:\d{4}\s+)?\d\d:\d\d:\d\d(?:\.\d+)?(?:\s+[A-Z]{3,4})?:?/, 'date'],
        [/%[A-Z0-9_]+-[0-3]-[A-Z0-9_]+:?/, 'log.error'],
        [/%[A-Z0-9_]+-4-[A-Z0-9_]+:?/, 'log.warn'],
        [/%[A-Z0-9_]+-[5-7]-[A-Z0-9_]+:?/, 'log.info'],
        [/\b(?:FATAL|CRITICAL|CRIT|ALERT|EMERG|EMERGENCY|ERROR|ERR|FAIL|FAILED|FAILURE|EXCEPTION|SEVERE|DENIED|REFUSED|UNREACHABLE)\b/i, 'log.error'],
        [/\b(?:down)\b/, 'log.error'],
        [/\b(?:WARN|WARNING|DEGRADED|RETRY|RETRYING|TIMEOUT|FLAP|FLAPPING)\b/i, 'log.warn'],
        [/\b(?:INFO|NOTICE|OK|SUCCESS|up)\b/, 'log.info'],
        [/\b(?:DEBUG|TRACE|VERBOSE)\b/i, 'log.debug'],
        [MAC, 'number.mac'],
        [IPV4, 'number.ip'],
        [IFACE, 'type.interface'],
        [/"[^"]*"/, 'string'],
        [/\b\d+(?:\.\d+)?\b/, 'number'],
      ],
    },
  });

  const rules = (dark) => [
    { token: 'comment', foreground: dark ? '6b7685' : '7a8494', fontStyle: 'italic' },
    { token: 'keyword.section', foreground: dark ? '73b9ff' : '1f6fc2', fontStyle: 'bold' },
    { token: 'keyword.sub', foreground: dark ? 'c39af0' : '8b46b8' },
    { token: 'keyword.no', foreground: dark ? 'f0a35b' : 'c0660f' },
    { token: 'keyword.permit', foreground: dark ? '3fbf6a' : '1f8a45', fontStyle: 'bold' },
    { token: 'keyword.deny', foreground: dark ? 'f0645b' : 'c8312a', fontStyle: 'bold' },
    { token: 'number.ip', foreground: dark ? '3cc4c4' : '127f86' },
    { token: 'number.mac', foreground: dark ? 'd3a6f5' : '8b46b8' },
    { token: 'type.interface', foreground: dark ? 'f5c76a' : '9a6b0e' },
    { token: 'date', foreground: dark ? '6b9fd4' : '3b6fa8' },
    { token: 'log.error', foreground: dark ? 'ff6b61' : 'c8312a', fontStyle: 'bold' },
    { token: 'log.warn', foreground: dark ? 'f0b44c' : 'b7791f', fontStyle: 'bold' },
    { token: 'log.info', foreground: dark ? '6ee08f' : '1f8a45' },
    { token: 'log.debug', foreground: dark ? '8b95a5' : '7a8494' },
  ];
  monaco.editor.defineTheme('konx-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: rules(true),
    colors: {
      'editor.background': '#13161b',
      'editorGutter.background': '#13161b',
      'editor.lineHighlightBackground': '#1b2028',
      'editor.lineHighlightBorder': '#1b2028',
      'editorLineNumber.foreground': '#4f5866',
      'editorLineNumber.activeForeground': '#c9d1dc',
      'editor.selectionBackground': '#2b4f75',
      'editor.inactiveSelectionBackground': '#25384d',
      'minimap.background': '#15181d',
      'editorWidget.background': '#20252e',
      'editorWidget.border': '#3a4250',
      'input.background': '#13161b',
      'scrollbarSlider.background': '#3a425080',
      'editorIndentGuide.background1': '#262c36',
    },
  });
  monaco.editor.defineTheme('konx-light', {
    base: 'vs',
    inherit: true,
    rules: rules(false),
    colors: { 'editor.background': '#fbfbfc', 'editorGutter.background': '#fbfbfc', 'editor.lineHighlightBackground': '#eef2f7', 'minimap.background': '#f3f5f8' },
  });
}
