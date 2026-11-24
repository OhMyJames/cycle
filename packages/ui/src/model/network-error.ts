/**
 * Whether an error's text reads as the network's (TLS, a timeout, DNS, a refused or reset connection): what a wrong or
 * missing proxy looks like (CYC-296). The turn's end then says to check the network or the proxy.
 */
const NETWORK = [
  /\btls\b/i,
  /handshake/i,
  /time(?:d)?[ -]?out/i,
  /\bdns\b/i,
  /no such host/i,
  /getaddrinfo/i,
  /\bENOTFOUND\b/,
  /\bECONN(?:REFUSED|RESET)\b/,
  /\bETIMEDOUT\b/,
  /connection (?:refused|reset)/i,
  /\bproxy\b/i,
  /certificate/i,
];

export const isNetworkError = (message: string | undefined): boolean =>
  message !== undefined && NETWORK.some((pattern) => pattern.test(message));
