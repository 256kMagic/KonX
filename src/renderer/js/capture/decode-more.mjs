// Protocol dissectors used by decode.mjs: switching (LLDP/CDP/STP/LACP/802.1X),
// routing (OSPF/BGP/VRRP/HSRP/PIM) and applications (DNS, DHCP, TLS, HTTP, SNMP...).
import { hex2, hex4, hex8, svc, ethernet, ipv4, ipv6, fmtIp6 } from './decode.mjs';

const latin = (c, o, n) => c.text(o, o + n, n);
const printable = (s) => s.replace(/[^\x20-\x7e]/g, '.');

// ================================================================ layer 2

export const l2 = {
  lldp(c, o) {
    const n = c.layer('lldp', 'Link Layer Discovery Protocol', o, c.end - o);
    const nb = { proto: 'LLDP', caps: [] };
    let p = o;
    const CHASSIS = { 4: 'MAC address', 5: 'Network address', 6: 'Interface name', 7: 'Locally assigned' };
    for (let i = 0; i < 64 && p + 2 <= c.d.length; i++) {
      const h = c.u16(p);
      const type = h >> 9;
      const len = h & 0x1ff;
      const v = p + 2;
      c.need(v, len);
      if (type === 0) {
        n.add('End of LLDPDU', p, 2);
        break;
      }
      const str = () => printable(latin(c, v + 1, len - 1));
      if (type === 1) {
        const st = c.u8(v);
        nb.chassis = st === 4 && len === 7 ? c.mac(v + 1) : st === 5 && c.u8(v + 1) === 1 ? c.ip4(v + 2) : str();
        n.add(`Chassis ID (${CHASSIS[st] || 'subtype ' + st}): ${nb.chassis}`, p, len + 2);
      } else if (type === 2) {
        const st = c.u8(v);
        nb.port = st === 3 && len === 7 ? c.mac(v + 1) : str();
        n.add(`Port ID: ${nb.port}`, p, len + 2);
      } else if (type === 3) {
        nb.ttl = c.u16(v);
        n.add(`Time To Live: ${nb.ttl} sec`, p, len + 2);
      } else if (type === 4) {
        nb.portDesc = printable(latin(c, v, len));
        n.add(`Port Description: ${nb.portDesc}`, p, len + 2);
      } else if (type === 5) {
        nb.device = printable(latin(c, v, len));
        n.add(`System Name: ${nb.device}`, p, len + 2);
      } else if (type === 6) {
        nb.platform = printable(latin(c, v, len)).trim();
        n.add(`System Description: ${nb.platform}`, p, len + 2);
      } else if (type === 7) {
        const en = c.u16(v + 2);
        nb.caps = ['Other', 'Repeater', 'Bridge', 'WLAN AP', 'Router', 'Telephone', 'DOCSIS', 'Station'].filter((_, i) => en & (1 << i));
        n.add(`Capabilities (enabled): ${nb.caps.join(', ') || 'none'}`, p, len + 2);
      } else if (type === 8) {
        const alen = c.u8(v);
        if (c.u8(v + 1) === 1 && alen === 5) nb.mgmt = c.ip4(v + 2);
        n.add(`Management Address: ${nb.mgmt || '(non-IPv4)'}`, p, len + 2);
      } else if (type === 127 && len >= 4) {
        const oui = (c.u8(v) << 16) | (c.u8(v + 1) << 8) | c.u8(v + 2);
        const st = c.u8(v + 3);
        if (oui === 0x0080c2 && st === 1) {
          nb.vlan = c.u16(v + 4);
          n.add(`IEEE 802.1 Port VLAN ID: ${nb.vlan}`, p, len + 2);
        } else if (oui === 0x0080c2 && st === 3) {
          n.add(`IEEE 802.1 VLAN Name: ${c.u16(v + 4)} ${printable(latin(c, v + 7, c.u8(v + 6)))}`, p, len + 2);
        } else if (oui === 0x0012bb && st === 2) {
          const app = c.u8(v + 4);
          const vlan = (c.u16(v + 5) >> 1) & 0xfff;
          if (app === 1) nb.voiceVlan = vlan;
          n.add(`LLDP-MED Network Policy: ${app === 1 ? 'Voice' : 'App ' + app}, VLAN ${vlan}`, p, len + 2);
        } else if (oui === 0x00120f && st === 4) {
          n.add(`IEEE 802.3 Maximum Frame Size: ${c.u16(v + 4)}`, p, len + 2);
        } else n.add(`Organization specific TLV (OUI ${oui.toString(16).padStart(6, '0')}, subtype ${st})`, p, len + 2);
      } else n.add(`TLV type ${type} (${len} bytes)`, p, len + 2);
      p = v + len;
    }
    nb.mac = c.r.f['eth.src'];
    c.r.neighbor = nb;
    Object.assign(c.r.f, { 'lldp.sysname': nb.device, 'lldp.port': nb.port, 'lldp.vlan': nb.vlan });
    c.top('LLDP', `${nb.device || nb.chassis || 'LLDP'}${nb.port ? ' port ' + nb.port : ''}${nb.vlan ? ' VLAN ' + nb.vlan : ''}${nb.mgmt ? ' mgmt ' + nb.mgmt : ''}`, 'l2');
    c.explain(`The device ${nb.device || nb.chassis} announces itself via LLDP: you are connected to its port ${nb.port}${nb.portDesc && nb.portDesc !== nb.port ? ' (' + nb.portDesc + ')' : ''}${nb.vlan ? ', native VLAN ' + nb.vlan : ''}.`);
  },

  cdp(c, o, end) {
    const ver = c.u8(o);
    const ttl = c.u8(o + 1);
    const n = c.layer('cdp', `Cisco Discovery Protocol v${ver}`, o, end - o);
    n.add(`Version: ${ver}`, o, 1);
    n.add(`TTL: ${ttl} seconds`, o + 1, 1);
    const nb = { proto: 'CDP', caps: [] };
    const addresses = (v) => {
      const count = c.u32(v);
      let q = v + 4;
      const out = [];
      for (let i = 0; i < count && i < 8; i++) {
        const plen = c.u8(q + 1);
        const isIp = plen === 1 && c.u8(q + 2) === 0xcc;
        const alen = c.u16(q + 2 + plen);
        if (isIp && alen === 4) out.push(c.ip4(q + 4 + plen));
        q += 4 + plen + alen;
      }
      return out;
    };
    let p = o + 4;
    while (p + 4 <= end) {
      const type = c.u16(p);
      const len = c.u16(p + 2);
      if (len < 4) break;
      const v = p + 4;
      const vlen = len - 4;
      c.need(v, vlen);
      const s = () => printable(latin(c, v, vlen));
      if (type === 1) {
        nb.device = s();
        n.add(`Device ID: ${nb.device}`, p, len);
      } else if (type === 2) {
        nb.addresses = addresses(v);
        n.add(`Addresses: ${nb.addresses.join(', ')}`, p, len);
      } else if (type === 3) {
        nb.port = s();
        n.add(`Port ID: ${nb.port}`, p, len);
      } else if (type === 4) {
        const caps = c.u32(v);
        nb.caps = ['Router', 'Transparent Bridge', 'Source Route Bridge', 'Switch', 'Host', 'IGMP', 'Repeater', 'Phone', 'Remote', 'CVTA', 'Two-port MAC Relay'].filter((_, i) => caps & (1 << i));
        n.add(`Capabilities: ${nb.caps.join(', ')}`, p, len);
      } else if (type === 5) {
        nb.software = s().split(/\.?\s*Copyright|[\r\n]/)[0].trim();
        n.add(`Software Version: ${nb.software}`, p, len);
      } else if (type === 6) {
        nb.platform = s();
        n.add(`Platform: ${nb.platform}`, p, len);
      } else if (type === 9) {
        nb.vtp = s();
        n.add(`VTP Management Domain: ${nb.vtp}`, p, len);
      } else if (type === 0x0a) {
        nb.vlan = c.u16(v);
        n.add(`Native VLAN: ${nb.vlan}`, p, len);
      } else if (type === 0x0b) {
        nb.duplex = c.u8(v) ? 'Full' : 'Half';
        n.add(`Duplex: ${nb.duplex}`, p, len);
      } else if (type === 0x0e && vlen >= 3) {
        nb.voiceVlan = c.u16(v + 1);
        n.add(`Voice VLAN: ${nb.voiceVlan}`, p, len);
      } else if (type === 0x16) {
        const m = addresses(v);
        nb.mgmt = m[0];
        n.add(`Management Addresses: ${m.join(', ')}`, p, len);
      } else n.add(`TLV 0x${hex4(type)} (${vlen} bytes)`, p, len);
      p += len;
    }
    nb.mgmt = nb.mgmt || (nb.addresses || [])[0];
    nb.mac = c.r.f['eth.src'];
    c.r.neighbor = nb;
    Object.assign(c.r.f, { 'cdp.deviceid': nb.device, 'cdp.portid': nb.port, 'cdp.platform': nb.platform, 'cdp.native_vlan': nb.vlan });
    c.top('CDP', `Device ID: ${nb.device}  Port ID: ${nb.port}${nb.vlan ? '  VLAN ' + nb.vlan : ''}`, 'l2');
    c.explain(`Cisco device ${nb.device}${nb.platform ? ' (' + nb.platform + ')' : ''} announces itself via CDP: you are plugged into its port ${nb.port}${nb.vlan ? ', native VLAN ' + nb.vlan : ''}${nb.voiceVlan ? ', voice VLAN ' + nb.voiceVlan : ''}.`);
  },

  stp(c, o, end, variant) {
    const ver = c.u8(o + 2);
    const type = c.u8(o + 3);
    const n = c.layer('stp', `Spanning Tree Protocol${variant === 'PVST+' ? ' (Cisco PVST+)' : ''}`, o, end - o);
    const vname = ver === 0 ? 'STP' : ver === 2 ? 'RSTP' : ver === 3 ? 'MSTP' : 'v' + ver;
    n.add(`Protocol Version: ${vname} (${ver})`, o + 2, 1);
    n.add(`BPDU Type: ${type === 0x80 ? 'Topology Change Notification' : type === 2 ? 'Rapid/Multiple Spanning Tree' : 'Configuration'} (0x${hex2(type)})`, o + 3, 1);
    if (type === 0x80) {
      c.r.stp = { tcn: true };
      c.r.f['stp.tcn'] = true;
      c.top('STP', 'Topology Change Notification', 'warn');
      c.explain('A switch is reporting a spanning-tree topology change (a port went up or down). Frequent changes flush MAC tables and cause flooding.');
      return;
    }
    const flags = c.u8(o + 4);
    const rootPrio = c.u16(o + 5);
    const rootMac = c.mac(o + 7);
    const cost = c.u32(o + 13);
    const bPrio = c.u16(o + 17);
    const bMac = c.mac(o + 19);
    const port = c.u16(o + 25);
    const tc = !!(flags & 1);
    const role = ['Unknown', 'Alternate/Backup', 'Root', 'Designated'][(flags >> 2) & 3];
    n.add(`Flags: 0x${hex2(flags)}${tc ? ' (Topology Change)' : ''}${ver >= 2 ? ', Port role: ' + role : ''}${flags & 0x20 ? ', Forwarding' : ''}${flags & 0x10 ? ', Learning' : ''}`, o + 4, 1);
    n.add(`Root Identifier: ${rootPrio & 0xf000} / ${rootPrio & 0xfff} / ${rootMac}`, o + 5, 8);
    n.add(`Root Path Cost: ${cost}`, o + 13, 4);
    n.add(`Bridge Identifier: ${bPrio & 0xf000} / ${bPrio & 0xfff} / ${bMac}`, o + 17, 8);
    n.add(`Port identifier: 0x${hex4(port)}`, o + 25, 2);
    n.add(`Hello Time: ${c.u16(o + 31) / 256}s, Max Age: ${c.u16(o + 29) / 256}s, Forward Delay: ${c.u16(o + 33) / 256}s`, o + 27, 8);
    const root = `${rootPrio & 0xf000}/${rootPrio & 0xfff}/${rootMac}`;
    c.r.stp = { root, rootMac, rootPrio: rootPrio & 0xf000, vlan: rootPrio & 0xfff, bridge: `${bPrio & 0xf000}/${bPrio & 0xfff}/${bMac}`, cost, tc, version: vname };
    Object.assign(c.r.f, { 'stp.root.hw': rootMac, 'stp.root.prio': rootPrio & 0xf000, 'stp.flags.tc': tc, 'stp.root.cost': cost });
    c.top(vname === 'STP' ? 'STP' : vname, `${ver >= 2 ? 'RST' : 'Conf'}. Root = ${root}  Cost = ${cost}  Port = 0x${hex4(port)}${tc ? '  [Topology Change]' : ''}`, tc ? 'warn' : 'l2');
    c.explain(`Spanning tree: the root bridge is ${rootMac} (priority ${rootPrio & 0xf000}${rootPrio & 0xfff ? ', VLAN ' + (rootPrio & 0xfff) : ''}); this switch is ${cost} cost away from it.${tc ? ' A topology change is in progress.' : ''}`);
  },

  slow(c, o) {
    const sub = c.u8(o);
    if (sub !== 1) return c.top('Slow Protocols', sub === 2 ? 'Marker protocol' : sub === 3 ? 'OAM (802.3ah)' : `Subtype ${sub}`, 'l2');
    const n = c.layer('lacp', 'Link Aggregation Control Protocol', o, 110);
    const side = (p, who) => {
      const prio = c.u16(p + 2);
      const sys = c.mac(p + 4);
      const key = c.u16(p + 10);
      const port = c.u16(p + 14);
      const st = c.u8(p + 16);
      const flags = ['Activity', 'Timeout', 'Aggregation', 'Synchronization', 'Collecting', 'Distributing', 'Defaulted', 'Expired'].filter((_, i) => st & (1 << i));
      n.add(`${who}: System ${prio}/${sys}, Key ${key}, Port ${port}, State: ${flags.join(', ')}`, p, 20);
      return { sys, key, port, flags };
    };
    const actor = side(o + 2, 'Actor');
    const partner = side(o + 22, 'Partner');
    c.r.lacp = { actor, partner };
    const sync = actor.flags.includes('Synchronization') && actor.flags.includes('Collecting');
    c.top('LACP', `Actor ${actor.sys} key ${actor.key} port ${actor.port} → Partner ${partner.sys === '00:00:00:00:00:00' ? '(none)' : partner.sys}${sync ? '' : ' [not in sync]'}`, sync ? 'l2' : 'warn');
    c.explain(partner.sys === '00:00:00:00:00:00' ? 'LACP is running but no partner has answered: the other end may not be configured for a port-channel.' : `LACP bundle between ${actor.sys} and ${partner.sys}${sync ? ', in sync and forwarding' : ', not yet in sync'}.`);
  },

  eapol(c, o) {
    const type = c.u8(o + 1);
    const n = c.layer('eapol', '802.1X Authentication', o, 4);
    const tname = ['EAP Packet', 'Start', 'Logoff', 'Key', 'Encapsulated ASF Alert'][type] || type;
    n.add(`Type: ${tname}`, o + 1, 1);
    let info = `EAPOL ${tname}`;
    if (type === 0) {
      const code = c.u8(o + 4);
      const cname = ['', 'Request', 'Response', 'Success', 'Failure'][code] || code;
      info = `EAP ${cname}`;
      if (code === 1 || code === 2) {
        const et = c.u8(o + 8);
        const ename = { 1: 'Identity', 3: 'Legacy Nak', 4: 'MD5-Challenge', 13: 'TLS', 21: 'TTLS', 25: 'PEAP', 43: 'FAST' }[et] || et;
        info += `, ${ename}`;
        if (et === 1 && code === 2) {
          const id = printable(latin(c, o + 9, c.u16(o + 6) - 5));
          info += ` (${id})`;
          c.r.f['eap.identity'] = id;
        }
      }
      if (code === 4) c.explain('802.1X authentication failed for this port.');
    }
    c.top('EAPOL', info, type === 0 && c.d[o + 4] === 4 ? 'bad' : 'l2');
  },
};

// ================================================================ routing

const OSPF_TYPES = { 1: 'Hello Packet', 2: 'DB Description', 3: 'LS Request', 4: 'LS Update', 5: 'LS Acknowledge' };

export const routing = {
  ospf(c, o, end, src) {
    const ver = c.u8(o);
    const type = c.u8(o + 1);
    const rid = c.ip4(o + 4);
    const area = c.ip4(o + 8);
    const n = c.layer('ospf', `Open Shortest Path First v${ver}`, o, end - o);
    n.add(`Message Type: ${OSPF_TYPES[type] || type}`, o + 1, 1);
    n.add(`Source OSPF Router: ${rid}`, o + 4, 4);
    n.add(`Area ID: ${area}${area === '0.0.0.0' ? ' (Backbone)' : ''}`, o + 8, 4);
    Object.assign(c.r.f, { 'ospf.msg': type, 'ospf.srcrouter': rid, 'ospf.area_id': area });
    let info = `${OSPF_TYPES[type] || 'Type ' + type}`;
    if (ver === 2 && type === 1) {
      const h = o + 24;
      const mask = c.ip4(h);
      const hello = c.u16(h + 4);
      const prio = c.u8(h + 7);
      const dead = c.u32(h + 8);
      const dr = c.ip4(h + 12);
      const bdr = c.ip4(h + 16);
      const neighbors = [];
      for (let p = h + 20; p + 4 <= end; p += 4) neighbors.push(c.ip4(p));
      n.add(`Network Mask: ${mask}`, h, 4);
      n.add(`Hello Interval: ${hello}s, Router Priority: ${prio}, Dead Interval: ${dead}s`, h + 4, 8);
      n.add(`Designated Router: ${dr}, Backup DR: ${bdr}`, h + 12, 8);
      n.add(`Active Neighbors: ${neighbors.join(', ') || 'none'}`, h + 20, neighbors.length * 4);
      c.r.ospf = { rid, area, hello, dead, dr, mask, neighbors };
      info += `, Router ${rid}, Area ${area}, Hello ${hello}s/Dead ${dead}s`;
      c.explain(`OSPF router ${rid} says hello on area ${area} (hello ${hello}s, dead ${dead}s, mask ${mask}). Neighbors must match these timers and mask to form an adjacency.`);
    }
    c.top(ver === 3 ? 'OSPFv3' : 'OSPF', info, 'routing');
  },

  vrrp(c, o, end, src) {
    const vt = c.u8(o);
    const vrid = c.u8(o + 1);
    const prio = c.u8(o + 2);
    const n = c.layer('vrrp', `Virtual Router Redundancy Protocol v${vt >> 4}`, o, end - o);
    n.add(`Virtual Router ID: ${vrid}`, o + 1, 1);
    n.add(`Priority: ${prio}${prio === 255 ? ' (owner)' : ''}`, o + 2, 1);
    const count = c.u8(o + 3);
    const ips = [];
    const base = (vt >> 4) === 2 ? o + 8 : o + 8;
    for (let i = 0; i < count; i++) ips.push(c.ip4(base + i * 4));
    n.add(`Virtual IPs: ${ips.join(', ')}`, base, count * 4);
    c.r.fhrp = { proto: 'VRRP', group: vrid, prio, vip: ips[0], src, state: 'Master' };
    c.top('VRRP', `Announcement (v${vt >> 4}) VRID ${vrid} Prio ${prio} VIP ${ips.join(', ')}`, 'routing');
    c.explain(`${src} is the VRRP master for virtual router ${vrid} (${ips.join(', ')}) with priority ${prio}.`);
  },

  hsrp(c, o, end, src) {
    const ver = c.u8(o);
    if (ver !== 0) return c.top('HSRPv2', 'HSRP version 2', 'routing');
    const op = c.u8(o + 1);
    const state = c.u8(o + 2);
    const prio = c.u8(o + 5);
    const group = c.u8(o + 6);
    const auth = printable(latin(c, o + 8, 8)).replace(/\.+$/, '');
    const vip = c.ip4(o + 16);
    const sname = { 0: 'Initial', 1: 'Learn', 2: 'Listen', 4: 'Speak', 8: 'Standby', 16: 'Active' }[state] || state;
    const n = c.layer('hsrp', 'Cisco Hot Standby Router Protocol', o, 20);
    n.add(`Op Code: ${['Hello', 'Coup', 'Resign'][op] || op}`, o + 1, 1);
    n.add(`State: ${sname}`, o + 2, 1);
    n.add(`Hellotime: ${c.u8(o + 3)}s, Holdtime: ${c.u8(o + 4)}s`, o + 3, 2);
    n.add(`Priority: ${prio}`, o + 5, 1);
    n.add(`Group: ${group}`, o + 6, 1);
    n.add(`Authentication Data: "${auth}" (clear text)`, o + 8, 8);
    n.add(`Virtual IP Address: ${vip}`, o + 16, 4);
    c.r.fhrp = { proto: 'HSRP', group, prio, vip, src, state: sname, auth };
    c.r.f['hsrp.group'] = group;
    c.r.f['hsrp.state'] = state;
    c.top('HSRP', `${['Hello', 'Coup', 'Resign'][op] || op} (state ${sname}) group ${group} prio ${prio} VIP ${vip}`, 'routing');
    c.explain(`${src} is HSRP ${sname} for group ${group} (virtual IP ${vip}, priority ${prio}).`);
  },

  bgp(c, o, end) {
    const types = { 1: 'OPEN', 2: 'UPDATE', 3: 'NOTIFICATION', 4: 'KEEPALIVE', 5: 'ROUTE-REFRESH' };
    const msgs = [];
    let p = o;
    while (p + 19 <= end) {
      const len = c.u16(p + 16);
      const type = c.u8(p + 18);
      if (len < 19) break;
      const n = c.layer('bgp', `Border Gateway Protocol - ${types[type] || type} Message`, p, len);
      n.add(`Length: ${len}`, p + 16, 2);
      n.add(`Type: ${types[type] || type}`, p + 18, 1);
      let txt = types[type] || `Type ${type}`;
      if (type === 1) {
        let as = c.u16(p + 20);
        const hold = c.u16(p + 22);
        const id = c.ip4(p + 24);
        // 4-octet AS capability
        const optLen = c.u8(p + 28);
        for (let q = p + 29; q + 2 <= p + 29 + optLen; ) {
          const ptype = c.u8(q);
          const plen = c.u8(q + 1);
          if (ptype === 2) {
            for (let r = q + 2; r + 2 <= q + 2 + plen; ) {
              const code = c.u8(r);
              const clen = c.u8(r + 1);
              if (code === 65 && clen === 4) as = c.u32(r + 2);
              r += 2 + clen;
            }
          }
          q += 2 + plen;
        }
        n.add(`My AS: ${as}, Hold Time: ${hold}, BGP Identifier: ${id}`, p + 19, 10);
        txt = `OPEN AS ${as}, ID ${id}, hold ${hold}s`;
        c.r.f['bgp.as'] = as;
      } else if (type === 3) {
        const code = c.u8(p + 19);
        const sub = c.u8(p + 20);
        const cname = { 1: 'Message Header Error', 2: 'OPEN Message Error', 3: 'UPDATE Message Error', 4: 'Hold Timer Expired', 5: 'FSM Error', 6: 'Cease' }[code] || code;
        n.add(`Error: ${cname} (subcode ${sub})`, p + 19, 2);
        txt = `NOTIFICATION ${cname}/${sub}`;
        c.r.bgpError = cname;
      } else if (type === 2) {
        const wlen = c.u16(p + 19);
        const alen = c.u16(p + 21 + wlen);
        const nlri = len - 23 - wlen - alen;
        txt = `UPDATE${wlen ? ' (withdrawals)' : ''}${nlri > 0 ? ' (new routes)' : ''}`;
      }
      msgs.push(txt);
      p += len;
    }
    c.r.f['bgp.type'] = msgs;
    c.top('BGP', msgs.join(', '), msgs.some((m) => m.startsWith('NOTIFICATION')) ? 'bad' : 'routing');
    if (msgs.some((m) => m.startsWith('NOTIFICATION'))) c.explain(`A BGP peer sent a NOTIFICATION (${c.r.bgpError}) and is tearing down the session.`);
  },

  pim(c, o) {
    const t = c.u8(o) & 15;
    const names = { 0: 'Hello', 1: 'Register', 2: 'Register-stop', 3: 'Join/Prune', 4: 'Bootstrap', 5: 'Assert', 8: 'Candidate-RP-Advertisement' };
    c.layer('pim', 'Protocol Independent Multicast', o, 4);
    c.top('PIM', `PIMv2 ${names[t] || t}`, 'routing');
  },
};

// ================================================================ applications

const DNS_TYPES = { 1: 'A', 2: 'NS', 5: 'CNAME', 6: 'SOA', 12: 'PTR', 13: 'HINFO', 15: 'MX', 16: 'TXT', 28: 'AAAA', 33: 'SRV', 35: 'NAPTR', 41: 'OPT', 43: 'DS', 46: 'RRSIG', 47: 'NSEC', 48: 'DNSKEY', 64: 'SVCB', 65: 'HTTPS', 255: 'ANY', 257: 'CAA' };
const RCODES = { 0: 'No error', 1: 'Format error', 2: 'Server failure', 3: 'No such name', 4: 'Not implemented', 5: 'Refused' };

function dnsName(c, base, p, depth = 0) {
  const labels = [];
  let end = null;
  for (let i = 0; i < 128; i++) {
    const len = c.u8(p);
    if (len === 0) {
      p++;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      const ptr = ((len & 0x3f) << 8) | c.u8(p + 1);
      if (end === null) end = p + 2;
      if (depth > 10) break;
      p = base + ptr;
      depth++;
      continue;
    }
    labels.push(printable(latin(c, p + 1, len)));
    p += 1 + len;
  }
  return { name: labels.join('.') || '<Root>', next: end === null ? p : end };
}

function nbDecode(s) {
  // NetBIOS first-level encoding: two letters per byte.
  let out = '';
  for (let i = 0; i + 1 < s.length; i += 2) out += String.fromCharCode(((s.charCodeAt(i) - 65) << 4) | (s.charCodeAt(i + 1) - 65));
  const suffix = out.charCodeAt(15);
  return `${out.slice(0, 15).trim()}<${hex2(isNaN(suffix) ? 0 : suffix)}>`;
}

const TLS_VERSIONS = { 0x0300: 'SSL 3.0', 0x0301: 'TLS 1.0', 0x0302: 'TLS 1.1', 0x0303: 'TLS 1.2', 0x0304: 'TLS 1.3' };
const CIPHERS = {
  0x1301: 'TLS_AES_128_GCM_SHA256', 0x1302: 'TLS_AES_256_GCM_SHA384', 0x1303: 'TLS_CHACHA20_POLY1305_SHA256',
  0xc02b: 'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256', 0xc02c: 'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384', 0xc02f: 'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
  0xc030: 'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384', 0xcca8: 'TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256', 0xcca9: 'TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256',
  0xc013: 'TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA', 0xc014: 'TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA', 0x009c: 'TLS_RSA_WITH_AES_128_GCM_SHA256',
  0x009d: 'TLS_RSA_WITH_AES_256_GCM_SHA384', 0x002f: 'TLS_RSA_WITH_AES_128_CBC_SHA', 0x0035: 'TLS_RSA_WITH_AES_256_CBC_SHA', 0x000a: 'TLS_RSA_WITH_3DES_EDE_CBC_SHA',
  0x0005: 'TLS_RSA_WITH_RC4_128_SHA',
};
const TLS_ALERTS = { 0: 'Close notify', 10: 'Unexpected message', 20: 'Bad record MAC', 40: 'Handshake failure', 42: 'Bad certificate', 43: 'Unsupported certificate', 44: 'Certificate revoked', 45: 'Certificate expired', 46: 'Certificate unknown', 47: 'Illegal parameter', 48: 'Unknown CA', 50: 'Decode error', 51: 'Decrypt error', 70: 'Protocol version', 71: 'Insufficient security', 80: 'Internal error', 90: 'User canceled', 109: 'Missing extension', 112: 'Unrecognized name', 116: 'Certificate required', 120: 'No application protocol' };
const HS_TYPES = { 0: 'Hello Request', 1: 'Client Hello', 2: 'Server Hello', 4: 'New Session Ticket', 8: 'Encrypted Extensions', 11: 'Certificate', 12: 'Server Key Exchange', 13: 'Certificate Request', 14: 'Server Hello Done', 15: 'Certificate Verify', 16: 'Client Key Exchange', 20: 'Finished' };

const SMB2_CMDS = ['Negotiate Protocol', 'Session Setup', 'Session Logoff', 'Tree Connect', 'Tree Disconnect', 'Create', 'Close', 'Flush', 'Read', 'Write', 'Lock', 'Ioctl', 'Cancel', 'Echo', 'Find', 'Notify', 'GetInfo', 'SetInfo', 'Break'];
const NT_STATUS = { 0: 'STATUS_SUCCESS', 0xc0000016: 'STATUS_MORE_PROCESSING_REQUIRED', 0xc000006d: 'STATUS_LOGON_FAILURE', 0xc0000022: 'STATUS_ACCESS_DENIED', 0xc0000034: 'STATUS_OBJECT_NAME_NOT_FOUND', 0xc00000cc: 'STATUS_BAD_NETWORK_NAME', 0xc0000072: 'STATUS_ACCOUNT_DISABLED', 0xc0000234: 'STATUS_ACCOUNT_LOCKED_OUT', 0xc0000071: 'STATUS_PASSWORD_EXPIRED', 0x103: 'STATUS_PENDING', 0x80000006: 'STATUS_NO_MORE_FILES' };

// BER (SNMP) helpers
function ber(c, p) {
  const tag = c.u8(p);
  let len = c.u8(p + 1);
  let hdr = 2;
  if (len & 0x80) {
    const nb = len & 0x7f;
    len = 0;
    for (let i = 0; i < nb; i++) len = len * 256 + c.u8(p + 2 + i);
    hdr += nb;
  }
  return { tag, len, v: p + hdr, next: p + hdr + len };
}
function berInt(c, t) {
  let v = 0;
  for (let i = 0; i < t.len; i++) v = v * 256 + c.u8(t.v + i);
  if (t.len && c.d[t.v] & 0x80) v -= 2 ** (8 * t.len);
  return v;
}
function berOid(c, t) {
  const parts = [];
  const first = c.u8(t.v);
  parts.push(Math.floor(first / 40), first % 40);
  let v = 0;
  for (let i = 1; i < t.len; i++) {
    const b = c.u8(t.v + i);
    v = v * 128 + (b & 0x7f);
    if (!(b & 0x80)) {
      parts.push(v);
      v = 0;
    }
  }
  return parts.join('.');
}
const OID_NAMES = { '1.3.6.1.2.1.1.1': 'sysDescr', '1.3.6.1.2.1.1.2': 'sysObjectID', '1.3.6.1.2.1.1.3': 'sysUpTime', '1.3.6.1.2.1.1.4': 'sysContact', '1.3.6.1.2.1.1.5': 'sysName', '1.3.6.1.2.1.1.6': 'sysLocation', '1.3.6.1.2.1.2.2.1.2': 'ifDescr', '1.3.6.1.2.1.2.2.1.8': 'ifOperStatus', '1.3.6.1.2.1.2.2.1.10': 'ifInOctets', '1.3.6.1.2.1.2.2.1.16': 'ifOutOctets', '1.3.6.1.2.1.31.1.1.1.1': 'ifName', '1.3.6.1.2.1.31.1.1.1.6': 'ifHCInOctets', '1.3.6.1.2.1.31.1.1.1.10': 'ifHCOutOctets', '1.3.6.1.6.3.1.1.4.1': 'snmpTrapOID' };
function oidName(oid) {
  for (const [k, v] of Object.entries(OID_NAMES)) if (oid === k || oid.startsWith(k + '.')) return `${v}${oid.slice(k.length)}`;
  return oid;
}
function berValue(c, t) {
  switch (t.tag) {
    case 0x02:
      return String(berInt(c, t));
    case 0x04: {
      const s = latin(c, t.v, t.len);
      return /^[\x20-\x7e\r\n\t]*$/.test(s) ? `"${s}"` : Array.from(c.bytes(t.v, t.len)).map(hex2).join(':');
    }
    case 0x05:
      return 'NULL';
    case 0x06:
      return oidName(berOid(c, t));
    case 0x40:
      return t.len === 4 ? c.ip4(t.v) : 'IpAddress';
    case 0x41:
    case 0x42:
    case 0x43:
    case 0x46: {
      let v = 0;
      for (let i = 0; i < t.len; i++) v = v * 256 + c.u8(t.v + i);
      return t.tag === 0x43 ? `${v} (${(v / 100 / 86400).toFixed(1)} days)` : String(v);
    }
    case 0x80:
      return 'noSuchObject';
    case 0x81:
      return 'noSuchInstance';
    case 0x82:
      return 'endOfMibView';
    default:
      return `tag 0x${hex2(t.tag)}`;
  }
}

function headers(lines) {
  const h = {};
  for (const l of lines) {
    const i = l.indexOf(':');
    if (i > 0) h[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  return h;
}

function b64decode(s) {
  try {
    return atob(s);
  } catch {
    return '';
  }
}

export const misc = {
  dns(c, o, end, kind, src, dst) {
    const id = c.u16(o);
    const flags = c.u16(o + 2);
    const qd = c.u16(o + 4);
    const an = c.u16(o + 6);
    const ns = c.u16(o + 8);
    const ar = c.u16(o + 10);
    const qr = flags >> 15;
    const rcode = flags & 15;
    const n = c.layer(kind.toLowerCase(), `${kind === 'DNS' ? 'Domain Name System' : kind} (${qr ? 'response' : 'query'})`, o, end - o);
    n.add(`Transaction ID: 0x${hex4(id)}`, o, 2);
    const fl = n.add(`Flags: 0x${hex4(flags)} ${qr ? 'Standard query response' : 'Standard query'}${rcode ? ', ' + RCODES[rcode] : ''}`, o + 2, 2);
    fl.add(`Recursion desired: ${flags & 0x100 ? 'yes' : 'no'}, Recursion available: ${flags & 0x80 ? 'yes' : 'no'}, Authoritative: ${flags & 0x400 ? 'yes' : 'no'}, Truncated: ${flags & 0x200 ? 'yes' : 'no'}`, o + 2, 2);
    fl.add(`Reply code: ${RCODES[rcode] || rcode} (${rcode})`, o + 3, 1);
    n.add(`Questions: ${qd}, Answer RRs: ${an}, Authority RRs: ${ns}, Additional RRs: ${ar}`, o + 4, 8);
    let p = o + 12;
    const qs = [];
    const qn = n.add('Queries', p, 0);
    for (let i = 0; i < qd && i < 16; i++) {
      const nm = dnsName(c, o, p);
      const type = c.u16(nm.next);
      const cls = c.u16(nm.next + 2);
      qs.push({ name: nm.name, type });
      qn.add(`${nm.name}: type ${DNS_TYPES[type] || type}, class ${(cls & 0x7fff) === 1 ? 'IN' : cls & 0x7fff}${cls & 0x8000 ? ' (QU)' : ''}`, p, nm.next + 4 - p);
      p = nm.next + 4;
    }
    const answers = [];
    const sections = [
      ['Answers', an],
      ['Authoritative nameservers', ns],
      ['Additional records', ar],
    ];
    for (const [title, count] of sections) {
      if (!count) continue;
      const sn = n.add(title, p, 0);
      for (let i = 0; i < count && i < 64; i++) {
        const start = p;
        const nm = dnsName(c, o, p);
        const type = c.u16(nm.next);
        const ttl = c.u32(nm.next + 4);
        const rdlen = c.u16(nm.next + 8);
        const rd = nm.next + 10;
        c.need(rd, rdlen);
        let data = '';
        if (type === 1 && rdlen === 4) data = c.ip4(rd);
        else if (type === 28 && rdlen === 16) data = fmtIp6(c.d, rd);
        else if ([2, 5, 12].includes(type)) data = dnsName(c, o, rd).name;
        else if (type === 15) data = `${c.u16(rd)} ${dnsName(c, o, rd + 2).name}`;
        else if (type === 16) data = `"${printable(latin(c, rd + 1, Math.min(c.u8(rd), rdlen - 1)))}"`;
        else if (type === 33) data = `${c.u16(rd)} ${c.u16(rd + 2)} ${c.u16(rd + 4)} ${dnsName(c, o, rd + 6).name}`;
        else if (type === 6) data = `${dnsName(c, o, rd).name} …`;
        else if (type === 41) data = `EDNS0 UDP payload ${c.u16(nm.next + 2)}`;
        else data = `${rdlen} bytes`;
        if (title === 'Answers') answers.push({ name: nm.name, type, ttl, data });
        sn.add(`${nm.name}: type ${DNS_TYPES[type] || type}${type === 41 ? '' : `, TTL ${ttl}`}, ${data}`, start, rd + rdlen - start);
        p = rd + rdlen;
      }
    }
    const q = qs[0] || { name: '', type: 0 };
    const f = c.r.f;
    Object.assign(f, {
      'dns.id': id,
      'dns.flags.response': !!qr,
      'dns.flags.rcode': rcode,
      'dns.qry.name': q.name,
      'dns.qry.type': q.type,
      'dns.count.answers': an,
      'dns.a': answers.filter((a) => a.type === 1).map((a) => a.data),
      'dns.aaaa': answers.filter((a) => a.type === 28).map((a) => a.data),
      'dns.cname': answers.filter((a) => a.type === 5).map((a) => a.data),
    });
    f.dns = true;
    c.r.dns = { id, qr: !!qr, rcode, qname: q.name, qtype: q.type, answers, kind };
    const tname = DNS_TYPES[q.type] || q.type;
    let info;
    if (!qr) {
      info = `Standard query 0x${hex4(id)} ${tname} ${q.name}`;
      c.explain(`${src} asked ${kind === 'DNS' ? 'DNS server ' + dst : 'the local network (' + kind + ')'} for the ${tname} record of ${q.name}.`);
    } else {
      const ans = answers.map((a) => `${DNS_TYPES[a.type] || a.type} ${a.data}`).join(' ');
      info = `Standard query response 0x${hex4(id)} ${rcode ? RCODES[rcode] + ' ' : ''}${tname} ${q.name}${ans ? ' ' + ans : ''}`;
      if (rcode === 3) c.explain(`${src} answered: ${q.name} does not exist (NXDOMAIN).`);
      else if (rcode) c.explain(`${src} failed to answer the query for ${q.name}: ${RCODES[rcode] || 'error ' + rcode}.`);
      else c.explain(`${src} answered: ${q.name} → ${answers.map((a) => a.data).join(', ') || '(no records)'}${answers[0] ? ` (cached for ${answers[0].ttl}s)` : ''}.`);
    }
    c.top(kind, info, rcode ? 'bad' : 'dns');
  },

  dhcp(c, o, end, src, dst) {
    const op = c.u8(o);
    const xid = c.u32(o + 4);
    const ciaddr = c.ip4(o + 12);
    const yiaddr = c.ip4(o + 16);
    const siaddr = c.ip4(o + 20);
    const giaddr = c.ip4(o + 24);
    const chaddr = c.mac(o + 28);
    const n = c.layer('dhcp', 'Dynamic Host Configuration Protocol', o, end - o);
    n.add(`Message type: Boot ${op === 1 ? 'Request' : 'Reply'} (${op})`, o, 1);
    n.add(`Transaction ID: 0x${hex8(xid)}`, o + 4, 4);
    n.add(`Client IP address: ${ciaddr}`, o + 12, 4);
    n.add(`Your (client) IP address: ${yiaddr}`, o + 16, 4);
    n.add(`Next server IP address: ${siaddr}`, o + 20, 4);
    n.add(`Relay agent IP address: ${giaddr}`, o + 24, 4);
    n.add(`Client MAC address: ${chaddr}`, o + 28, 6);
    const TYPES = { 1: 'Discover', 2: 'Offer', 3: 'Request', 4: 'Decline', 5: 'ACK', 6: 'NAK', 7: 'Release', 8: 'Inform' };
    const d = { xid, op, yiaddr, ciaddr, chaddr, giaddr };
    if (c.u32(o + 236) === 0x63825363) {
      const on = n.add('Options', o + 240, end - o - 240);
      let p = o + 240;
      while (p < end) {
        const code = c.u8(p);
        if (code === 0) {
          p++;
          continue;
        }
        if (code === 255) {
          on.add('End', p, 1);
          break;
        }
        const len = c.u8(p + 1);
        const v = p + 2;
        c.need(v, len);
        const ips = () => {
          const a = [];
          for (let i = 0; i + 4 <= len; i += 4) a.push(c.ip4(v + i));
          return a;
        };
        let label;
        switch (code) {
          case 53:
            d.type = c.u8(v);
            label = `DHCP Message Type: ${TYPES[d.type] || d.type}`;
            break;
          case 50:
            d.requested = c.ip4(v);
            label = `Requested IP Address: ${d.requested}`;
            break;
          case 54:
            d.server = c.ip4(v);
            label = `DHCP Server Identifier: ${d.server}`;
            break;
          case 51:
            d.lease = c.u32(v);
            label = `IP Address Lease Time: ${d.lease}s (${(d.lease / 3600).toFixed(1)} h)`;
            break;
          case 1:
            d.mask = c.ip4(v);
            label = `Subnet Mask: ${d.mask}`;
            break;
          case 3:
            d.router = ips();
            label = `Router: ${d.router.join(', ')}`;
            break;
          case 6:
            d.dns = ips();
            label = `Domain Name Server: ${d.dns.join(', ')}`;
            break;
          case 12:
            d.hostname = printable(latin(c, v, len));
            label = `Host Name: ${d.hostname}`;
            break;
          case 15:
            d.domain = printable(latin(c, v, len)).replace(/\.$/, '');
            label = `Domain Name: ${d.domain}`;
            break;
          case 60:
            d.vendor = printable(latin(c, v, len));
            label = `Vendor class identifier: ${d.vendor}`;
            break;
          case 66:
            label = `TFTP Server Name: ${printable(latin(c, v, len))}`;
            break;
          case 82:
            label = 'Relay Agent Information (option 82)';
            break;
          case 55:
            label = `Parameter Request List (${len} items)`;
            break;
          default:
            label = `Option ${code} (${len} bytes)`;
        }
        on.add(`(${code}) ${label}`, p, len + 2);
        p = v + len;
      }
    }
    const tn = TYPES[d.type] || (op === 1 ? 'Request' : 'Reply');
    c.r.dhcp = d;
    Object.assign(c.r.f, { 'dhcp.type': d.type, 'dhcp.hw.mac_addr': chaddr, 'dhcp.ip.your': yiaddr, 'dhcp.option.hostname': d.hostname, 'dhcp.option.dhcp_server_id': d.server });
    c.r.f.bootp = true;
    let info = `DHCP ${tn} - Transaction ID 0x${hex8(xid)}`;
    if (d.type === 2 || d.type === 5) info += ` ${yiaddr}`;
    c.top('DHCP', info, d.type === 6 ? 'bad' : 'dhcp');
    const who = d.hostname ? `${d.hostname} (${chaddr})` : chaddr;
    const expl = {
      1: `${who} is broadcasting to find a DHCP server so it can get an IP address.`,
      2: `DHCP server ${d.server || src} offers ${yiaddr} to ${chaddr}${d.router ? ', gateway ' + d.router[0] : ''}${d.dns ? ', DNS ' + d.dns.join('/') : ''}.`,
      3: `${who} is requesting ${d.requested || ciaddr}${d.server ? ' from server ' + d.server : ''}.`,
      5: `DHCP server ${d.server || src} confirmed: ${chaddr} now has ${yiaddr || ciaddr}${d.lease ? ' for ' + (d.lease / 3600).toFixed(1) + ' hours' : ''}.`,
      6: `DHCP server ${d.server || src} refused the request (NAK) from ${chaddr}; the client must start over.`,
      7: `${who} is giving its address ${ciaddr} back.`,
    };
    if (expl[d.type]) c.explain(expl[d.type]);
  },

  dhcpv6(c, o, end) {
    const t = c.u8(o);
    const names = { 1: 'Solicit', 2: 'Advertise', 3: 'Request', 4: 'Confirm', 5: 'Renew', 6: 'Rebind', 7: 'Reply', 8: 'Release', 9: 'Decline', 10: 'Reconfigure', 11: 'Information-request', 12: 'Relay-forw', 13: 'Relay-reply' };
    const n = c.layer('dhcpv6', 'DHCPv6', o, end - o);
    n.add(`Message type: ${names[t] || t}`, o, 1);
    c.top('DHCPv6', `${names[t] || t} XID: 0x${(c.u32(o) & 0xffffff).toString(16)}`, 'dhcp');
  },

  ntp(c, o, end, src, dst) {
    const b = c.u8(o);
    const vn = (b >> 3) & 7;
    const mode = b & 7;
    const stratum = c.u8(o + 1);
    const MODES = ['reserved', 'symmetric active', 'symmetric passive', 'client', 'server', 'broadcast', 'control', 'private'];
    const n = c.layer('ntp', 'Network Time Protocol', o, end - o);
    n.add(`Leap Indicator: ${b >> 6}, Version: ${vn}, Mode: ${MODES[mode]}`, o, 1);
    n.add(`Peer Clock Stratum: ${stratum}${stratum === 1 ? ' (primary reference)' : stratum === 16 || stratum === 0 ? ' (unsynchronized)' : ''}`, o + 1, 1);
    const refId = stratum <= 1 ? printable(latin(c, o + 12, 4)).replace(/\.+$/, '') : c.ip4(o + 12);
    n.add(`Reference ID: ${refId}`, o + 12, 4);
    const tsec = c.u32(o + 40);
    if (tsec) n.add(`Transmit Timestamp: ${new Date((tsec - 2208988800) * 1000).toISOString()}`, o + 40, 8);
    c.r.f['ntp.stratum'] = stratum;
    c.top('NTP', `NTP Version ${vn}, ${MODES[mode]}${mode === 4 ? `, stratum ${stratum}` : ''}`, stratum === 16 && mode === 4 ? 'warn' : 'udp');
    c.explain(mode === 3 ? `${src} is asking ${dst} for the time.` : `${src} supplied the time (stratum ${stratum}${refId ? ', reference ' + refId : ''}).`);
  },

  snmp(c, o, end, src, dst, sp, dp) {
    const top = ber(c, o);
    if (top.tag !== 0x30) return c.top('SNMP', 'SNMP (malformed)', 'udp');
    const vt = ber(c, top.v);
    const version = berInt(c, vt);
    const vname = { 0: 'v1', 1: 'v2c', 3: 'v3' }[version] || version;
    const n = c.layer('snmp', `Simple Network Management Protocol ${vname}`, o, end - o);
    n.add(`Version: ${vname}`, vt.v, vt.len);
    if (version === 3) {
      c.top('SNMP', 'SNMPv3 (encrypted/authenticated)', 'udp');
      return;
    }
    const ct = ber(c, vt.next);
    const community = latin(c, ct.v, ct.len);
    n.add(`Community: ${community} (sent in clear text)`, ct.v, ct.len);
    const pdu = ber(c, ct.next);
    const PDUS = { 0xa0: 'get-request', 0xa1: 'get-next-request', 0xa2: 'get-response', 0xa3: 'set-request', 0xa4: 'trap', 0xa5: 'getBulkRequest', 0xa6: 'inform-request', 0xa7: 'snmpV2-trap', 0xa8: 'report' };
    const pname = PDUS[pdu.tag] || `PDU 0x${hex2(pdu.tag)}`;
    const pn = n.add(`Data: ${pname}`, pdu.v, pdu.len);
    const binds = [];
    let errStatus = 0;
    if (pdu.tag !== 0xa4) {
      const rid = ber(c, pdu.v);
      const es = ber(c, rid.next);
      const ei = ber(c, es.next);
      errStatus = berInt(c, es);
      pn.add(`Request ID: ${berInt(c, rid)}`, rid.v, rid.len);
      pn.add(`Error status: ${['noError', 'tooBig', 'noSuchName', 'badValue', 'readOnly', 'genErr', 'noAccess', 'wrongType'][errStatus] || errStatus}`, es.v, es.len);
      const vbl = ber(c, ei.next);
      let p = vbl.v;
      while (p < vbl.next && binds.length < 32) {
        const vb = ber(c, p);
        const oid = ber(c, vb.v);
        const val = ber(c, oid.next);
        const s = `${oidName(berOid(c, oid))} = ${berValue(c, val)}`;
        binds.push(s);
        pn.add(s, vb.v, vb.len);
        p = vb.next;
      }
    }
    c.r.snmp = { version: vname, community, pdu: pname, binds };
    Object.assign(c.r.f, { 'snmp.community': community, 'snmp.version': version });
    c.top('SNMP', `${pname} ${binds.slice(0, 3).join(' ')}${binds.length > 3 ? ' …' : ''}`, errStatus ? 'bad' : 'udp');
    c.explain(`${src} ${pname.includes('response') ? 'answered an SNMP query from' : pname.includes('trap') ? 'sent an SNMP trap to' : 'queried SNMP on'} ${dst} using SNMP ${vname} community "${community}", which is sent in clear text.`);
  },

  syslog(c, o, end, src) {
    const s = latin(c, o, Math.min(end - o, 1024));
    const m = s.match(/^<(\d{1,3})>/);
    const SEV = ['EMERG', 'ALERT', 'CRIT', 'ERR', 'WARNING', 'NOTICE', 'INFO', 'DEBUG'];
    const FAC = ['KERN', 'USER', 'MAIL', 'DAEMON', 'AUTH', 'SYSLOG', 'LPR', 'NEWS', 'UUCP', 'CRON', 'AUTHPRIV', 'FTP', 'NTP', 'AUDIT', 'ALERT', 'CLOCK', 'LOCAL0', 'LOCAL1', 'LOCAL2', 'LOCAL3', 'LOCAL4', 'LOCAL5', 'LOCAL6', 'LOCAL7'];
    const n = c.layer('syslog', 'Syslog message', o, end - o);
    let info = printable(s).trim();
    if (m) {
      const pri = Number(m[1]);
      const sev = pri & 7;
      const fac = pri >> 3;
      n.add(`Facility: ${FAC[fac] || fac}, Severity: ${SEV[sev]}`, o, m[0].length);
      info = `${FAC[fac] || fac}.${SEV[sev]}: ${printable(s.slice(m[0].length)).trim()}`;
      c.r.f['syslog.level'] = sev;
      c.top('Syslog', info, sev <= 3 ? 'bad' : sev === 4 ? 'warn' : 'udp');
    } else c.top('Syslog', info, 'udp');
    n.add(`Message: ${printable(s).trim()}`, o, end - o);
    c.explain(`${src} sent a syslog message.`);
  },

  http(c, o, end, src, dst, proto) {
    const text = c.text(o, end, 8192);
    const headEnd = text.indexOf('\r\n\r\n');
    const lines = (headEnd >= 0 ? text.slice(0, headEnd) : text).split(/\r?\n/);
    const first = lines[0];
    const h = headers(lines.slice(1));
    const n = c.layer(proto.toLowerCase(), proto === 'HTTP' ? 'Hypertext Transfer Protocol' : 'Simple Service Discovery Protocol', o, end - o);
    n.add(first, o, first.length + 2);
    let off = o + first.length + 2;
    for (const l of lines.slice(1)) {
      if (/^authorization:\s*basic\s+/i.test(l)) {
        const creds = b64decode(l.replace(/^authorization:\s*basic\s+/i, '').trim());
        const [user, ...rest] = creds.split(':');
        const hn = n.add(l, off, l.length);
        hn.add(`Credentials: user "${user}", password "${rest.join(':')}"`, off, l.length);
        c.r.cred = { proto: 'HTTP Basic', user, host: h.host || dst, src };
      } else n.add(l, off, l.length);
      off += l.length + 2;
    }
    const f = c.r.f;
    const req = first.match(/^([A-Z-]+) (\S+) (HTTP\/[\d.]+)/);
    const res = first.match(/^HTTP\/[\d.]+ (\d{3}) ?(.*)$/);
    if (req) {
      Object.assign(f, { 'http.request.method': req[1], 'http.request.uri': req[2], 'http.host': h.host, 'http.user_agent': h['user-agent'] });
      f['http.request'] = true;
      c.r.http = { method: req[1], uri: req[2], host: h.host };
      c.top(proto, first, 'http');
      if (proto === 'HTTP') c.explain(`${src} requested http://${h.host || dst}${req[2]} (${req[1]}). This is unencrypted.`);
      else c.explain(`${src} is ${req[1] === 'M-SEARCH' ? 'searching for devices/services' : 'announcing a service'} via SSDP (UPnP).`);
    } else if (res) {
      const code = Number(res[1]);
      Object.assign(f, { 'http.response.code': code, 'http.content_type': h['content-type'], 'http.server': h.server });
      f['http.response'] = true;
      c.r.http = { status: code };
      c.top(proto, `${first}${h['content-type'] ? ' (' + h['content-type'].split(';')[0] + ')' : ''}`, code >= 400 ? 'bad' : 'http');
      if (proto === 'HTTP') c.explain(`${src} answered with HTTP ${code} ${res[2]}${h.server ? ' (server: ' + h.server + ')' : ''}.`);
    } else c.top(proto, printable(first).slice(0, 120), 'http');
  },

  tls(c, o, end, src, dst) {
    const parts = [];
    const t = {};
    let p = o;
    while (p + 5 <= end) {
      const type = c.d[p];
      const ver = (c.d[p + 1] << 8) | c.d[p + 2];
      const len = (c.d[p + 3] << 8) | c.d[p + 4];
      if (type < 20 || type > 23 || c.d[p + 1] !== 3) break;
      const recEnd = Math.min(end, p + 5 + len);
      const n = c.layer('tls', `Transport Layer Security, ${TLS_VERSIONS[ver] || 'TLS'} Record Layer: ${{ 20: 'Change Cipher Spec', 21: 'Alert', 22: 'Handshake', 23: 'Application Data' }[type]}`, p, recEnd - p);
      n.add(`Content Type: ${{ 20: 'Change Cipher Spec', 21: 'Alert', 22: 'Handshake', 23: 'Application Data' }[type]} (${type})`, p, 1);
      n.add(`Version: ${TLS_VERSIONS[ver] || hex4(ver)}`, p + 1, 2);
      n.add(`Length: ${len}`, p + 3, 2);
      if (type === 22) {
        let q = p + 5;
        while (q + 4 <= recEnd) {
          const ht = c.d[q];
          const hlen = (c.d[q + 1] << 16) | (c.d[q + 2] << 8) | c.d[q + 3];
          if (!HS_TYPES[ht]) {
            parts.push('Encrypted Handshake Message');
            break;
          }
          const hn = n.add(`Handshake Protocol: ${HS_TYPES[ht]}`, q, Math.min(recEnd, q + 4 + hlen) - q);
          let label = HS_TYPES[ht];
          try {
            if (ht === 1 || ht === 2) {
              const hv = c.u16(q + 4);
              let r = q + 6 + 32;
              const sidLen = c.u8(r);
              r += 1 + sidLen;
              if (ht === 1) {
                const csLen = c.u16(r);
                hn.add(`Cipher Suites (${csLen / 2} suites)`, r, csLen + 2);
                r += 2 + csLen;
                r += 1 + c.u8(r);
              } else {
                t.cipher = c.u16(r);
                hn.add(`Cipher Suite: ${CIPHERS[t.cipher] || '0x' + hex4(t.cipher)}`, r, 2);
                r += 3;
              }
              t.version = hv;
              const extEnd = r + 2 + c.u16(r);
              r += 2;
              while (r + 4 <= Math.min(extEnd, recEnd)) {
                const et = c.u16(r);
                const el = c.u16(r + 2);
                const v = r + 4;
                if (et === 0 && ht === 1) {
                  t.sni = latin(c, v + 5, c.u16(v + 3));
                  hn.add(`Extension: server_name: ${t.sni}`, r, el + 4);
                } else if (et === 16) {
                  const alpn = [];
                  for (let a = v + 2; a < v + el; a += 1 + c.u8(a)) alpn.push(latin(c, a + 1, c.u8(a)));
                  t.alpn = alpn;
                  hn.add(`Extension: ALPN: ${alpn.join(', ')}`, r, el + 4);
                } else if (et === 43) {
                  if (ht === 1) {
                    const vs = [];
                    for (let a = v + 1; a + 2 <= v + 1 + c.u8(v); a += 2) vs.push(c.u16(a));
                    t.offered = vs;
                    hn.add(`Extension: supported_versions: ${vs.filter((x) => TLS_VERSIONS[x]).map((x) => TLS_VERSIONS[x]).join(', ')}`, r, el + 4);
                  } else {
                    t.version = c.u16(v);
                    hn.add(`Extension: supported_versions: ${TLS_VERSIONS[t.version]}`, r, el + 4);
                  }
                } else hn.add(`Extension: type ${et} (${el} bytes)`, r, el + 4);
                r = v + el;
              }
              if (ht === 1) label = `Client Hello${t.sni ? ` (SNI=${t.sni})` : ''}`;
              else label = `Server Hello, ${TLS_VERSIONS[t.version] || ''}, ${CIPHERS[t.cipher] || '0x' + hex4(t.cipher)}`;
              t.hello = ht;
            }
          } catch {
            label += ' (continues in next segment)';
          }
          parts.push(label);
          q += 4 + hlen;
        }
      } else if (type === 21) {
        if (len === 2) {
          const lvl = c.u8(p + 5);
          const desc = c.u8(p + 6);
          t.alert = { level: lvl === 2 ? 'Fatal' : 'Warning', desc: TLS_ALERTS[desc] || desc };
          n.add(`Alert: ${t.alert.level}, ${t.alert.desc}`, p + 5, 2);
          parts.push(`Alert (${t.alert.level}, ${t.alert.desc})`);
        } else parts.push('Encrypted Alert');
      } else if (type === 20) parts.push('Change Cipher Spec');
      else parts.push('Application Data');
      p += 5 + len;
    }
    const f = c.r.f;
    if (t.sni) f['tls.handshake.extensions_server_name'] = t.sni;
    if (t.version) f['tls.handshake.version'] = t.version;
    if (t.cipher) f['tls.handshake.ciphersuite'] = t.cipher;
    if (t.hello) f['tls.handshake.type'] = t.hello;
    if (t.alert) f['tls.alert'] = t.alert.desc;
    c.r.tls = t;
    const uniq = [...new Set(parts)];
    c.top(t.version === 0x0304 || (t.offered || []).includes(0x0304) ? 'TLSv1.3' : t.version ? (TLS_VERSIONS[t.version] || 'TLS').replace(' ', 'v') : 'TLS', uniq.join(', ') || 'TLS segment', t.alert && t.alert.level === 'Fatal' ? 'bad' : 'tls');
    if (t.hello === 1) c.explain(`${src} is starting an encrypted TLS session with ${t.sni || dst}${t.alpn ? ' (' + t.alpn.join('/') + ')' : ''}.`);
    else if (t.hello === 2) c.explain(`${src} agreed to ${TLS_VERSIONS[t.version] || 'TLS'} using ${CIPHERS[t.cipher] || 'cipher 0x' + hex4(t.cipher)}.`);
    else if (t.alert) c.explain(`${src} sent a TLS alert: ${t.alert.desc}${t.alert.level === 'Fatal' ? ' (the connection will be dropped)' : ''}.`);
    else c.explain(`${src} sent encrypted data to ${dst}.`);
  },

  ssh(c, o, end, sp, dp) {
    const s = c.text(o, end, 256);
    const n = c.layer('ssh', 'SSH Protocol', o, end - o);
    if (s.startsWith('SSH-')) {
      const banner = s.split(/\r?\n/)[0];
      n.add(`Protocol: ${banner}`, o, banner.length);
      c.r.f['ssh.protocol'] = banner;
      c.top('SSH', `${sp === 22 ? 'Server' : 'Client'}: ${banner}`, 'tls');
      c.explain(`The ${sp === 22 ? 'server' : 'client'} identifies its SSH software as ${banner}.`);
      return;
    }
    const plen = c.u32(o);
    const code = end - o > 5 && plen < 35000 ? c.u8(o + 5) : -1;
    const MSG = { 20: 'Key Exchange Init', 21: 'New Keys', 30: 'Elliptic Curve Diffie-Hellman Key Exchange Init', 31: 'Elliptic Curve Diffie-Hellman Key Exchange Reply' };
    if (MSG[code] && plen + 4 <= end - o + 4) {
      n.add(`Message Code: ${MSG[code]}`, o + 5, 1);
      c.top('SSHv2', MSG[code], 'tls');
    } else c.top('SSHv2', `Encrypted packet (len=${end - o})`, 'tls');
  },

  smb(c, o, end) {
    const h = o + 4;
    const smb1 = c.u8(h) === 0xff;
    if (smb1) {
      c.layer('smb', 'SMB (Server Message Block Protocol) v1', h, end - h);
      c.r.f.smb1 = true;
      c.top('SMB', `SMBv1 command 0x${hex2(c.u8(h + 4))}`, 'warn');
      c.explain('This host is speaking SMBv1, an obsolete and insecure protocol (exploited by WannaCry). Disable SMBv1.');
      return;
    }
    // SMB2 header fields are little-endian.
    const le16 = (p) => c.u8(p) | (c.u8(p + 1) << 8);
    const le32 = (p) => (le16(p) + le16(p + 2) * 65536) >>> 0;
    const status = le32(h + 8);
    const cmd = le16(h + 12);
    const flags = le32(h + 16);
    const resp = !!(flags & 1);
    const n = c.layer('smb2', 'SMB2 (Server Message Block Protocol version 2)', h, end - h);
    n.add(`Command: ${SMB2_CMDS[cmd] || cmd} (${cmd})`, h + 12, 2);
    n.add(`NT Status: ${NT_STATUS[status] || '0x' + hex8(status)}`, h + 8, 4);
    n.add(`Flags: ${resp ? 'Response' : 'Request'}`, h + 16, 4);
    Object.assign(c.r.f, { 'smb2.cmd': cmd, 'smb2.nt_status': status });
    const bad = resp && status !== 0 && status !== 0xc0000016 && status !== 0x103;
    c.r.smb = { cmd: SMB2_CMDS[cmd], status: NT_STATUS[status] || '0x' + hex8(status), error: bad };
    c.top('SMB2', `${SMB2_CMDS[cmd] || 'Command ' + cmd} ${resp ? 'Response' : 'Request'}${bad ? ', Error: ' + (NT_STATUS[status] || '0x' + hex8(status)) : ''}`, bad ? 'bad' : 'tcp');
    if (bad) c.explain(`The SMB server refused the ${SMB2_CMDS[cmd]} request: ${NT_STATUS[status] || '0x' + hex8(status)}.`);
  },

  tacacs(c, o, end) {
    const ver = c.u8(o);
    const type = c.u8(o + 1);
    const flags = c.u8(o + 3);
    const n = c.layer('tacplus', 'TACACS+', o, end - o);
    n.add(`Type: ${['', 'Authentication', 'Authorization', 'Accounting'][type] || type}`, o + 1, 1);
    n.add(`Flags: ${flags & 1 ? 'UNENCRYPTED' : 'Encrypted'}`, o + 3, 1);
    if (flags & 1) c.r.insecure = 'TACACS+ without encryption key';
    c.top('TACACS+', `${['', 'Authentication', 'Authorization', 'Accounting'][type] || type}${flags & 1 ? ' (unencrypted!)' : ''}`, flags & 1 ? 'warn' : 'tcp');
  },

  textProto(c, o, end, sp, dp, src, dst) {
    const proto = sp === 21 || dp === 21 ? 'FTP' : sp === 23 || dp === 23 ? 'Telnet' : [25, 587].includes(sp) || [25, 587].includes(dp) ? 'SMTP' : sp === 110 || dp === 110 ? 'POP' : 'IMAP';
    const raw = c.text(o, end, 1024);
    const n = c.layer(proto.toLowerCase(), proto, o, end - o);
    if (proto === 'Telnet') {
      const txt = printable(raw.replace(/\xff[\xfb-\xfe][\s\S]|\xff\xfa[\s\S]*?\xff\xf0/g, '')).trim();
      n.add(`Data: ${txt || '(option negotiation)'}`, o, end - o);
      c.r.insecure = 'Telnet (unencrypted remote login)';
      c.top('TELNET', txt ? `Telnet Data: ${txt.slice(0, 80)}` : 'Telnet option negotiation', 'warn');
      c.explain('Telnet sends everything, including passwords, in clear text. Use SSH instead.');
      return;
    }
    const line = raw.split(/\r?\n/)[0];
    n.add(printable(line), o, line.length);
    const toServer = [21, 25, 587, 110, 143].includes(dp);
    let m;
    if (proto === 'FTP' && toServer && (m = line.match(/^USER (.+)$/i))) c.r.credPart = { proto: 'FTP', user: m[1], src, host: dst };
    if (proto === 'FTP' && toServer && (m = line.match(/^PASS (.+)$/i))) c.r.cred = { proto: 'FTP', password: m[1], src, host: dst };
    if (proto === 'POP' && toServer && (m = line.match(/^USER (.+)$/i))) c.r.credPart = { proto: 'POP3', user: m[1], src, host: dst };
    if (proto === 'POP' && toServer && (m = line.match(/^PASS (.+)$/i))) c.r.cred = { proto: 'POP3', password: m[1], src, host: dst };
    if (proto === 'IMAP' && toServer && (m = line.match(/^\S+ LOGIN (\S+) (\S+)/i))) c.r.cred = { proto: 'IMAP', user: m[1], password: m[2], src, host: dst };
    c.r.f[proto.toLowerCase() + '.request'] = toServer;
    c.top(proto, `${toServer ? 'Request' : 'Response'}: ${printable(line).slice(0, 120)}`, c.r.cred ? 'warn' : 'tcp');
    if (c.r.cred || c.r.credPart) c.explain(`${src} is logging in to ${proto} in clear text. Anyone on the path can read the credentials.`);
  },

  sip(c, o, end) {
    const lines = c.text(o, end, 2048).split(/\r?\n/);
    const h = headers(lines.slice(1));
    c.layer('sip', 'Session Initiation Protocol', o, end - o).add(lines[0], o, lines[0].length);
    c.r.f['sip.call_id'] = h['call-id'];
    c.top('SIP', `${lines[0]}${h['call-id'] ? ' (Call-ID ' + h['call-id'].slice(0, 20) + ')' : ''}`, 'udp');
  },

  nbns(c, o, end) {
    const flags = c.u16(o + 2);
    const resp = !!(flags & 0x8000);
    const nlen = c.u8(o + 12);
    const name = nbDecode(latin(c, o + 13, nlen));
    c.layer('nbns', 'NetBIOS Name Service', o, end - o).add(`Name: ${name}`, o + 12, nlen + 2);
    c.r.f['nbns.name'] = name;
    c.top('NBNS', `Name ${resp ? 'query response' : 'query'} NB ${name}`, 'udp');
  },

  tftp(c, o, end) {
    const op = c.u16(o);
    const n = c.layer('tftp', 'Trivial File Transfer Protocol', o, end - o);
    const s = c.text(o + 2, end, 512).split('\0');
    let info;
    if (op === 1 || op === 2) {
      info = `${op === 1 ? 'Read' : 'Write'} Request, File: ${s[0]}, Transfer type: ${s[1]}`;
      c.r.f['tftp.source_file'] = s[0];
    } else if (op === 3) info = `Data Packet, Block: ${c.u16(o + 2)}`;
    else if (op === 4) info = `Acknowledgement, Block: ${c.u16(o + 2)}`;
    else if (op === 5) info = `Error Code, Code: ${c.u16(o + 2)}, Message: ${c.text(o + 4, end, 256).split('\0')[0]}`;
    else info = `Opcode ${op}`;
    n.add(info, o, end - o);
    c.top('TFTP', info, op === 5 ? 'bad' : 'udp');
  },

  vxlan(c, o, end) {
    const vni = (c.u32(o + 4) >>> 8) & 0xffffff;
    c.layer('vxlan', `Virtual eXtensible Local Area Network, VNI: ${vni}`, o, 8).add(`VXLAN Network Identifier: ${vni}`, o + 4, 3);
    c.r.f['vxlan.vni'] = vni;
    ethernet(c, o + 8);
  },

  radius(c, o, end) {
    const code = c.u8(o);
    const CODES = { 1: 'Access-Request', 2: 'Access-Accept', 3: 'Access-Reject', 4: 'Accounting-Request', 5: 'Accounting-Response', 11: 'Access-Challenge', 40: 'Disconnect-Request', 43: 'CoA-Request' };
    const n = c.layer('radius', 'RADIUS Protocol', o, end - o);
    n.add(`Code: ${CODES[code] || code}`, o, 1);
    let user = '';
    for (let p = o + 20; p + 2 <= end; ) {
      const t = c.u8(p);
      const l = c.u8(p + 1);
      if (l < 2) break;
      if (t === 1) user = printable(latin(c, p + 2, l - 2));
      p += l;
    }
    if (user) {
      n.add(`User-Name: ${user}`, o + 20, 0);
      c.r.f['radius.user_name'] = user;
    }
    c.top('RADIUS', `${CODES[code] || code} id=${c.u8(o + 1)}${user ? ' user ' + user : ''}`, code === 3 ? 'bad' : 'udp');
    if (code === 3) c.explain(`RADIUS rejected the login${user ? ' for ' + user : ''}.`);
  },

  isakmp(c, o, end, natt) {
    let p = o;
    if (natt && c.u32(o) === 0) p += 4; // non-ESP marker
    const ver = c.u8(p + 17);
    const ex = c.u8(p + 18);
    const EX = { 2: 'Identity Protection (Main Mode)', 4: 'Aggressive', 5: 'Informational', 32: 'Quick Mode', 34: 'IKE_SA_INIT', 35: 'IKE_AUTH', 36: 'CREATE_CHILD_SA', 37: 'INFORMATIONAL' };
    c.layer('isakmp', `Internet Security Association and Key Management Protocol (IKEv${ver >> 4})`, p, end - p);
    c.top('ISAKMP', `IKEv${ver >> 4} ${EX[ex] || 'exchange ' + ex}`, ex === 4 ? 'warn' : 'udp');
    if (ex === 4) c.r.insecure = 'IKEv1 Aggressive Mode (exposes a crackable PSK hash)';
  },

  stun(c, o, end) {
    const t = c.u16(o);
    const names = { 0x0001: 'Binding Request', 0x0101: 'Binding Success Response', 0x0111: 'Binding Error Response' };
    if (c.u32(o + 4) !== 0x2112a442) return;
    c.layer('stun', 'Session Traversal Utilities for NAT', o, end - o);
    c.top('STUN', names[t] || `Message 0x${hex4(t)}`, 'udp');
  },

  netflow(c, o, end) {
    const ver = c.u16(o);
    const count = c.u16(o + 2);
    c.layer('cflow', `Cisco NetFlow/IPFIX v${ver}`, o, end - o);
    c.top(ver === 10 ? 'IPFIX' : 'CFLOW', `${ver === 10 ? 'IPFIX' : 'NetFlow v' + ver}, ${ver === 10 ? count + ' bytes' : count + ' records'}`, 'udp');
  },

  quic(c, o, end) {
    const b = c.u8(o);
    const n = c.layer('quic', 'QUIC IETF', o, end - o);
    if (b & 0x80) {
      const ver = c.u32(o + 1);
      const dcl = c.u8(o + 5);
      const dcid = Array.from(c.bytes(o + 6, dcl)).map(hex2).join('');
      const type = ver === 0 ? 'Version Negotiation' : ['Initial', '0-RTT', 'Handshake', 'Retry'][(b >> 4) & 3];
      n.add(`Long Header: ${type}, Version 0x${hex8(ver)}, DCID ${dcid}`, o, 6 + dcl);
      c.top('QUIC', `${type}, DCID=${dcid.slice(0, 16)}`, 'tls');
    } else if (b & 0x40) c.top('QUIC', 'Protected Payload (short header)', 'tls');
  },

  pppoe(c, o, type) {
    const code = c.u8(o + 1);
    const sid = c.u16(o + 2);
    const n = c.layer('pppoe', `PPP-over-Ethernet ${type === 0x8863 ? 'Discovery' : 'Session'}`, o, 6);
    if (type === 0x8863) {
      const CODES = { 0x09: 'Active Discovery Initiation (PADI)', 0x07: 'Active Discovery Offer (PADO)', 0x19: 'Active Discovery Request (PADR)', 0x65: 'Active Discovery Session-confirmation (PADS)', 0xa7: 'Active Discovery Terminate (PADT)' };
      n.add(`Code: ${CODES[code] || code}`, o + 1, 1);
      return c.top('PPPoED', CODES[code] || `Code 0x${hex2(code)}`, 'l2');
    }
    const proto = c.u16(o + 6);
    n.add(`Session ID: 0x${hex4(sid)}, PPP protocol 0x${hex4(proto)}`, o + 2, 6);
    if (proto === 0x0021) return ipv4(c, o + 8);
    if (proto === 0x0057) return ipv6(c, o + 8);
    if (proto === 0xc023) c.r.insecure = 'PPP PAP (clear-text password)';
    c.top('PPP', { 0xc021: 'LCP', 0x8021: 'IPCP', 0xc023: 'PAP (clear-text authentication)', 0xc223: 'CHAP' }[proto] || `PPP 0x${hex4(proto)}`, proto === 0xc023 ? 'warn' : 'l2');
  },

  igmp(c, o, end, src) {
    const t = c.u8(o);
    const group = c.ip4(o + 4);
    const TYPES = { 0x11: 'Membership Query', 0x12: 'v1 Membership Report', 0x16: 'v2 Membership Report', 0x17: 'Leave Group', 0x22: 'v3 Membership Report' };
    c.layer('igmp', 'Internet Group Management Protocol', o, end - o).add(`Type: ${TYPES[t] || t}`, o, 1);
    c.r.f['igmp.maddr'] = group;
    c.top('IGMP', `${TYPES[t] || 'Type 0x' + hex2(t)}${t !== 0x22 && group !== '0.0.0.0' ? ' ' + group : ''}`, 'routing');
    c.explain(t === 0x11 ? `${src} (a multicast router/querier) is asking which multicast groups are wanted.` : t === 0x17 ? `${src} is leaving multicast group ${group}.` : `${src} wants to receive multicast traffic${t !== 0x22 ? ' for ' + group : ''}.`);
  },

  gre(c, o, end) {
    const fl = c.u16(o);
    const proto = c.u16(o + 2);
    let p = o + 4;
    if (fl & 0x8000) p += 4;
    if (fl & 0x2000) p += 4;
    if (fl & 0x1000) p += 4;
    const n = c.layer('gre', `Generic Routing Encapsulation (${proto === 0x88be ? 'ERSPAN' : '0x' + hex4(proto)})`, o, p - o);
    n.add(`Protocol Type: 0x${hex4(proto)}`, o + 2, 2);
    if (proto === 0x0800) return ipv4(c, p);
    if (proto === 0x86dd) return ipv6(c, p);
    if (proto === 0x6558) return ethernet(c, p);
    if (proto === 0x88be || proto === 0x22eb) {
      // ERSPAN type II (8-byte header) or type III (12 bytes, +8 with platform sub-header)
      const ver = c.u8(p) >> 4;
      const sid = c.u16(p) & 0x3ff;
      let hl = proto === 0x22eb ? 12 + (c.u8(p + 11) & 1 ? 8 : 0) : 8;
      if (ver === 2) hl = 12 + (c.u8(p + 11) & 1 ? 8 : 0);
      c.layer('erspan', `Encapsulated Remote Switch Packet Analysis Type ${ver === 2 ? 'III' : 'II'}, Session ${sid}`, p, hl);
      c.r.f['erspan.session'] = sid;
      return ethernet(c, p + hl);
    }
    c.top('GRE', `Encapsulated 0x${hex4(proto)}`, 'routing');
  },

  esp(c, o) {
    const spi = c.u32(o);
    const seq = c.u32(o + 4);
    c.layer('esp', 'Encapsulating Security Payload', o, 8).add(`SPI: 0x${hex8(spi)}, Sequence: ${seq}`, o, 8);
    c.top('ESP', `ESP (SPI=0x${hex8(spi)})`, 'tls');
  },

  sctp(c, o, end) {
    const sp = c.u16(o);
    const dp = c.u16(o + 2);
    c.layer('sctp', 'Stream Control Transmission Protocol', o, 12);
    c.r.f['sctp.port'] = [sp, dp];
    c.top('SCTP', `${sp} → ${dp}`, 'udp');
  },
};
