'use strict';

const { verify } = require('node:crypto');

// Public-only synthetic verification vector. ssh2 lists ssh-dss independently
// of crypto-provider support; Electron/BoringSSL cannot verify DSA signatures.
// Probe the actual primitive once rather than infer support from runtime names.
const DSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBtzCCASsGByqGSM44BAEwggEeAoGBAI/4QStlSMJhd5t7spEiONbPTkVsrXT6
6LdsC5tZUZJdhx3PWw+7NcblSqt3BjvXgCxtfUJ2g9BeEbnWAiFpKlc152n0DKO4
lcTx8AMNfPNa8voRpyYoCfmD4OoW24SxHYg1lGKmW10DRAZlRpccm8+tJx6WQxOA
LUIaq6B9sDldAhUA5XTSoKsKTcd9tMuHdXrUlokTTpkCgYA+0RrKP3HNck9o4Bxl
LmsKIPhUWYOqwn5ysr40UpLh9b/8ByBLE7GBA/kvtUPXb9qFPysxYuX88rCpsSZg
79lUMe2sHilGLFmi2LLWpvkDDsx3oPXOqSAYqJg8bIKUKLRF4BOQ8W7OS2E2jleF
r/eMqgQCuFmP/rYg8Cf6+o0VhQOBhQACgYEAhP73g1LcIIleg9TaVLXHTVXe4hSi
RmEs7f9P715nVA3DLWAYIJSj/GFM/D3dDu917PtwluUBxjmtQmkkaWl7EOG0zohP
SSPqFIvSSigmisjxlIJ4ZuIjrKe1MODP4ZG2LROKXvX9BBMnnClKSNMjy+4tNeaX
Zshfskxy1iFTVbI=
-----END PUBLIC KEY-----`;
const DSA_MESSAGE = Buffer.from('KonX synthetic DSA runtime verification capability v1');
const DSA_SIGNATURE = Buffer.from('MC4CFQCS2ePy2ZQYzC0aK/k9I0wsGKq1XQIVAMiDMrpZZUgeCtSyFjiAinEgrXEW', 'base64');

let dsaAvailable;
function supportsDsa() {
  if (dsaAvailable === undefined) {
    try { dsaAvailable = verify('sha1', DSA_MESSAGE, DSA_PUBLIC_KEY, DSA_SIGNATURE) === true; }
    catch { dsaAvailable = false; }
  }
  return dsaAvailable;
}

module.exports = { supportsDsa };
