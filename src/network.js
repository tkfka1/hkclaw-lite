import dns from 'node:dns';

export const PREFERRED_DNS_RESULT_ORDER = 'ipv4first';

export function preferIpv4Dns() {
  if (typeof dns.setDefaultResultOrder !== 'function') {
    return false;
  }

  dns.setDefaultResultOrder(PREFERRED_DNS_RESULT_ORDER);
  return true;
}

preferIpv4Dns();
