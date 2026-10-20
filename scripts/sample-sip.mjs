import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sipDemoCapture } from '../test/lib/sip-fixtures.mjs';

if (process.argv.length > 3) throw new Error('Usage: npm run sample:sip -- [output.pcapng]');
const target = path.resolve(process.argv[2] || 'user-data/sip-demo.pcapng');
await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, sipDemoCapture());
console.log(`Created ${target}`);
console.log('23 synthetic packets, 3 SIP calls. Open the file in Packet Capture, then click SIP Calls.');
