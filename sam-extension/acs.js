// acs.js — shared ACS routing, validation, and metadata.
// No secrets live here. Token handling is confined to background.js.

// ACS serves production and STAGING stacks — staging uses the same API shape
// on a staging.admin.* host (the CLI equivalent is --server=https://staging...).
// Dev stacks are NOT supported by ACS at all; there is no environment entry
// for them on purpose.
export const ENVIRONMENTS = {
  govcloud_il2: {
    id: "govcloud_il2",
    label: "GovCloud IL2 (FedRAMP Moderate)",
    host: "https://admin.splunkcloudgc.com",
    badge: "GOVCLOUD IL2",
    restricted: true,
    staging: false,
  },
  govcloud_il2_staging: {
    id: "govcloud_il2_staging",
    label: "GovCloud IL2 — Staging",
    host: "https://staging.admin.splunkcloudgc.com",
    badge: "GOVCLOUD IL2 · STAGING",
    restricted: true,
    staging: true,
  },
  commercial: {
    id: "commercial",
    label: "Commercial",
    host: "https://admin.splunk.com",
    badge: "COMMERCIAL",
    restricted: false,
    staging: false,
  },
  commercial_staging: {
    id: "commercial_staging",
    label: "Commercial — Staging",
    host: "https://staging.admin.splunk.com",
    badge: "COMMERCIAL · STAGING",
    restricted: false,
    staging: true,
  },
};

export const EXPERIENCES = {
  victoria: { id: "victoria", label: "Victoria" },
  classic: { id: "classic", label: "Classic" },
};

// IP allow list feature categories. Endpoint shape is identical across
// Victoria and Classic — experience is carried on the profile because other
// ACS surfaces (apps, indexes) do branch on it.
export const FEATURES = [
  {
    id: "search-api",
    label: "Search API",
    ports: "8089",
    risk: "high",
    note: "REST and API access. Removing the subnet you automate from will lock out your own tooling.",
  },
  {
    id: "search-ui",
    label: "Search UI (Splunk Web)",
    ports: "80, 443",
    risk: "high",
    note: "Browser access to Splunk Web. Removing your current subnet can lock you out of the UI.",
  },
  {
    id: "hec",
    label: "HTTP Event Collector",
    ports: "443",
    risk: "medium",
    note: "HEC ingest. Removing a subnet silently stops data from those senders.",
  },
  {
    id: "acs",
    label: "ACS (Admin Config Service)",
    ports: null, // the service itself, not a stack port
    risk: "high",
    note:
      "Access to the Admin Config Service itself — the API this extension uses. " +
      "Removing your own subnet locks SAM and all ACS automation out of the stack. IPv4 only.",
  },
  {
    id: "idm-ui",
    label: "IDM UI",
    ports: "443",
    risk: "medium",
    note:
      "Browser access to the Inputs Data Manager UI in regulated environments. " +
      "Removing your subnet blocks the IDM console.",
  },
  {
    id: "idm-api",
    label: "IDM API",
    ports: "8089",
    risk: "medium",
    note:
      "API access for add-ons that send data through the IDM to Splunk Cloud. " +
      "Removing a subnet stops those add-ons.",
  },
  {
    id: "s2s",
    label: "Forwarders (S2S)",
    ports: "9997",
    risk: "medium",
    note: "Splunk-to-Splunk forwarder ingest. Removing a subnet stops those forwarders.",
  },
];

// Authoritative references, surfaced in the popup footer.
export const PORT_DOC_URL =
  "https://docs.splunk.com/Documentation/SplunkCloud/latest/Config/ConfigureIPAllowList";
export const ACS_USAGE_URL =
  "https://docs.splunk.com/Documentation/SplunkCloud/latest/Config/ACSusage";
// Internal KCS article (Salesforce Knowledge). Linked to the article itself,
// without the ws= workspace parameter that pins it to one Case.
export const KCS_ARTICLE_URL =
  "https://splunk.lightning.force.com/lightning/r/Knowledge__kav/ka0KW000000wne3YAA/view";

/**
 * Stand-in for the bearer token in every curl string SAM *renders*. The real
 * token is substituted only by the service worker, only into the clipboard,
 * and only on an explicit copy. Nothing on screen ever shows the credential.
 */
export const CURL_PLACEHOLDER_TOKEN = "eyJraWQiOiJzcGx1bmsuc2...";

/** Build the equivalent curl command, so SAM stays runbook-compatible. */
export function buildCurl({ envId, stack, feature, ipVersion, method, subnets }) {
  const url = buildIpAllowListUrl({ envId, stack, feature, ipVersion });
  const token = CURL_PLACEHOLDER_TOKEN;

  if (method === "GET") {
    return `curl ${url} --header 'Authorization: Bearer ${token}'`;
  }
  const body = JSON.stringify({ subnets });
  return [
    `curl -X ${method} '${url}' \\`,
    `--header 'Content-Type: application/json' \\`,
    `--header 'Authorization: Bearer ${token}' \\`,
    `--data '${body}'`,
  ].join("\n");
}

export function featureById(id) {
  return FEATURES.find((f) => f.id === id) || null;
}

/**
 * Build the ACS IP allow list URL.
 * IPv4: /{stack}/adminconfig/v2/access/{feature}/ipallowlists
 * IPv6: /{stack}/adminconfig/v2/access/{feature}/ipallowlists-v6
 */
export function buildIpAllowListUrl({ envId, stack, feature, ipVersion }) {
  const env = ENVIRONMENTS[envId];
  if (!env) throw new Error(`Unknown environment: ${envId}`);

  const cleanStack = String(stack || "").trim().toLowerCase();
  if (!cleanStack) throw new Error("Stack name is required.");
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(cleanStack)) {
    throw new Error(
      `Stack name "${stack}" looks invalid. Use the URL prefix of the deployment, e.g. csms-2io6tw-47150.`
    );
  }

  if (!featureById(feature)) throw new Error(`Unknown feature: ${feature}`);

  const path = ipVersion === "v6" ? "ipallowlists-v6" : "ipallowlists";
  return `${env.host}/${cleanStack}/adminconfig/v2/access/${feature}/${path}`;
}

/* ---------------------------------------------------------------------- *
 * CIDR validation + public address space enforcement
 *
 * ACS allow lists gate access from the public internet. A private, loopback,
 * link-local, or otherwise non-routable subnet can never be the source of a
 * real connection, so entering one is always a mistake — usually someone
 * pasting an internal address instead of their egress IP.
 * ---------------------------------------------------------------------- */

// IPv4 blocks that are not publicly routable. Source: IANA IPv4 Special-Purpose
// Address Registry (RFC 6890 and successors).
const V4_RESERVED = [
  ["0.0.0.0/8", '"This network" — not a routable source address'],
  ["10.0.0.0/8", "RFC 1918 private network"],
  ["100.64.0.0/10", "RFC 6598 carrier-grade NAT space"],
  ["127.0.0.0/8", "Loopback"],
  ["169.254.0.0/16", "Link-local (APIPA)"],
  ["172.16.0.0/12", "RFC 1918 private network"],
  ["192.0.0.0/24", "IETF protocol assignments"],
  ["192.0.2.0/24", "TEST-NET-1, documentation only"],
  ["192.88.99.0/24", "Deprecated 6to4 relay anycast"],
  ["192.168.0.0/16", "RFC 1918 private network"],
  ["198.18.0.0/15", "Benchmarking"],
  ["198.51.100.0/24", "TEST-NET-2, documentation only"],
  ["203.0.113.0/24", "TEST-NET-3, documentation only"],
  ["224.0.0.0/4", "Multicast"],
  ["240.0.0.0/4", "Reserved / broadcast"],
];

const V6_RESERVED = [
  ["::/128", "Unspecified address"],
  ["::1/128", "Loopback"],
  ["::ffff:0:0/96", "IPv4-mapped address"],
  ["64:ff9b::/96", "NAT64 translation"],
  ["100::/64", "Discard-only address block"],
  ["2001:db8::/32", "Documentation only"],
  ["fc00::/7", "Unique local address (ULA), not routable"],
  ["fe80::/10", "Link-local"],
  ["ff00::/8", "Multicast"],
];

/* ---------------------------- IPv4 numerics ---------------------------- */

function v4ToInt(addr) {
  return addr.split(".").reduce((acc, o) => acc * 256 + Number(o), 0);
}

function v4IntToStr(int) {
  return [(int >>> 24) & 255, (int >>> 16) & 255, (int >>> 8) & 255, int & 255].join(".");
}

function v4Range(cidr) {
  const [addr, prefix] = cidr.split("/");
  const size = Math.pow(2, 32 - Number(prefix));
  const start = Math.floor(v4ToInt(addr) / size) * size;
  return [start, start + size - 1];
}

/* ---------------------------- IPv6 numerics ---------------------------- */

function expandV6(addr) {
  const halves = addr.split("::");
  if (halves.length > 2) return null;

  if (halves.length === 2) {
    const head = halves[0] ? halves[0].split(":") : [];
    const tail = halves[1] ? halves[1].split(":") : [];
    // An empty group on either side means a stray colon, e.g. "2600:::1".
    if (head.some((g) => g === "") || tail.some((g) => g === "")) return null;
    // "::" must stand in for at least one zero group.
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    return [...head, ...Array(fill).fill("0"), ...tail];
  }

  const groups = addr.split(":");
  if (groups.length !== 8 || groups.some((g) => g === "")) return null;
  return groups;
}

function v6ToBigInt(addr) {
  const groups = expandV6(addr);
  if (!groups) return null;
  let n = 0n;
  for (const g of groups) n = (n << 16n) + BigInt(parseInt(g, 16));
  return n;
}

function v6BigIntToStr(n) {
  const groups = [];
  for (let i = 7; i >= 0; i--) {
    groups.push(((n >> BigInt(i * 16)) & 0xffffn).toString(16));
  }
  // Compress the longest run of zero groups.
  let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
  groups.forEach((g, i) => {
    if (g === "0") {
      if (curStart === -1) curStart = i;
      curLen++;
      if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
    } else {
      curStart = -1; curLen = 0;
    }
  });
  if (bestLen > 1) {
    return (
      groups.slice(0, bestStart).join(":") + "::" + groups.slice(bestStart + bestLen).join(":")
    );
  }
  return groups.join(":");
}

function v6Range(cidr) {
  const [addr, prefix] = cidr.split("/");
  const n = v6ToBigInt(addr);
  if (n === null) return null;
  const hostBits = BigInt(128 - Number(prefix));
  const size = 1n << hostBits;
  const start = (n / size) * size;
  return [start, start + size - 1n];
}

/* ---------------------------- overlap check ---------------------------- */

function overlaps(a, b) {
  return a[0] <= b[1] && b[0] <= a[1];
}

function contains(outer, inner) {
  return outer[0] <= inner[0] && inner[1] <= outer[1];
}

function checkPublicV4(normalized) {
  if (normalized.endsWith("/0")) {
    return {
      public: false,
      error:
        "0.0.0.0/0 allows the entire internet. Enter the specific public subnet that needs access.",
    };
  }
  const range = v4Range(normalized);
  for (const [block, why] of V4_RESERVED) {
    const bRange = v4Range(block);
    if (!overlaps(range, bRange)) continue;
    if (contains(bRange, range)) {
      return { public: false, error: `${normalized} is inside ${block} — ${why}. Allow lists need a public IP.` };
    }
    return {
      public: false,
      error:
        `${normalized} overlaps the reserved block ${block} (${why}). ` +
        `Split it into ranges that stay in public address space.`,
    };
  }
  return { public: true };
}

function checkPublicV6(normalized) {
  if (normalized.endsWith("/0")) {
    return {
      public: false,
      error: "::/0 allows the entire internet. Enter the specific public subnet that needs access.",
    };
  }
  const range = v6Range(normalized);
  if (!range) return { public: true };
  for (const [block, why] of V6_RESERVED) {
    const bRange = v6Range(block);
    if (!bRange || !overlaps(range, bRange)) continue;
    if (contains(bRange, range)) {
      return { public: false, error: `${normalized} is inside ${block} — ${why}. Allow lists need a public IP.` };
    }
    return {
      public: false,
      error: `${normalized} overlaps the reserved block ${block} (${why}). Narrow the range.`,
    };
  }
  return { public: true };
}

/* ---------------------------- validators ---------------------------- */

export function validateIpv4Cidr(input, { requirePublic = true } = {}) {
  const raw = String(input || "").trim();
  if (!raw) return { ok: false, error: "Empty value." };

  const [addr, prefixRaw, ...rest] = raw.split("/");
  if (rest.length) return { ok: false, error: `"${raw}" has more than one "/".` };

  const octets = addr.split(".");
  if (octets.length !== 4) {
    return { ok: false, error: `"${raw}" is not a valid IPv4 address — expected four octets.` };
  }
  for (const o of octets) {
    if (!/^\d{1,3}$/.test(o)) {
      return { ok: false, error: `"${raw}" has a non-numeric octet: "${o}".` };
    }
    if (Number(o) > 255) {
      return { ok: false, error: `"${raw}" has an octet out of range: "${o}" (max 255).` };
    }
    if (o.length > 1 && o.startsWith("0")) {
      return { ok: false, error: `"${raw}" has a leading zero in "${o}" — write it without padding.` };
    }
  }

  // A bare address is treated as a single host (/32), which is what ACS expects.
  let prefix = 32;
  if (prefixRaw !== undefined) {
    if (!/^\d{1,2}$/.test(prefixRaw)) {
      return { ok: false, error: `"${raw}" has a malformed prefix length.` };
    }
    prefix = Number(prefixRaw);
    if (prefix > 32) {
      return { ok: false, error: `"${raw}" has prefix /${prefix} — IPv4 maximum is /32.` };
    }
  }

  const warnings = [];
  const entered = `${octets.map(Number).join(".")}/${prefix}`;
  const [start] = v4Range(entered);
  const network = `${v4IntToStr(start)}/${prefix}`;

  if (network !== entered) {
    warnings.push(
      `${entered} has host bits set; normalized to its network address ${network}.`
    );
  }

  if (requirePublic) {
    const verdict = checkPublicV4(network);
    if (!verdict.public) return { ok: false, error: verdict.error };
  }

  return { ok: true, value: network, prefix, warnings };
}

export function validateIpv6Cidr(input, { requirePublic = true } = {}) {
  const raw = String(input || "").trim();
  if (!raw) return { ok: false, error: "Empty value." };

  const [addr, prefixRaw, ...rest] = raw.split("/");
  if (rest.length) return { ok: false, error: `"${raw}" has more than one "/".` };

  if ((addr.match(/::/g) || []).length > 1) {
    return { ok: false, error: `"${raw}" has more than one "::".` };
  }
  if (!/^[0-9a-fA-F:]+$/.test(addr)) {
    return { ok: false, error: `"${raw}" contains characters that are not valid in IPv6.` };
  }
  for (const g of addr.split(":")) {
    if (g.length > 4) {
      return { ok: false, error: `"${raw}" has an oversized group: "${g}" (max 4 hex digits).` };
    }
  }
  if (expandV6(addr) === null) {
    return { ok: false, error: `"${raw}" is not a valid IPv6 address — expected 8 groups or "::".` };
  }

  let prefix = 128;
  if (prefixRaw !== undefined) {
    if (!/^\d{1,3}$/.test(prefixRaw)) {
      return { ok: false, error: `"${raw}" has a malformed prefix length.` };
    }
    prefix = Number(prefixRaw);
    if (prefix > 128) {
      return { ok: false, error: `"${raw}" has prefix /${prefix} — IPv6 maximum is /128.` };
    }
  }

  const warnings = [];
  const entered = `${addr.toLowerCase()}/${prefix}`;
  const range = v6Range(entered);
  const network = `${v6BigIntToStr(range[0])}/${prefix}`;

  if (v6ToBigInt(addr) !== range[0]) {
    warnings.push(`${entered} has host bits set; normalized to ${network}.`);
  }

  if (requirePublic) {
    const verdict = checkPublicV6(network);
    if (!verdict.public) return { ok: false, error: verdict.error };
  }

  return { ok: true, value: network, prefix, warnings };
}

export function validateCidr(input, ipVersion, opts) {
  return ipVersion === "v6" ? validateIpv6Cidr(input, opts) : validateIpv4Cidr(input, opts);
}

/**
 * Parse a textarea of subnets (newline or comma separated) into
 * normalized values, per-line errors, and normalization warnings.
 */
export function parseSubnetList(text, ipVersion, opts) {
  const tokens = String(text || "")
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const valid = [];
  const errors = [];
  const warnings = [];
  const seen = new Set();

  for (const token of tokens) {
    const result = validateCidr(token, ipVersion, opts);
    if (!result.ok) {
      errors.push(result.error);
      continue;
    }
    if (result.warnings) warnings.push(...result.warnings);
    if (!seen.has(result.value)) {
      seen.add(result.value);
      valid.push(result.value);
    }
  }
  return { valid, errors, warnings };
}

/**
 * Flag changes that are plausible lockout events, so the confirm step can
 * say something specific instead of a generic "are you sure".
 */
export function assessRemoval({ feature, subnets, currentList }) {
  const meta = featureById(feature);
  const warnings = [];

  if (meta && meta.risk === "high") {
    warnings.push(meta.note);
  }

  const remaining = (currentList || []).filter((s) => !subnets.includes(s));
  if (currentList && currentList.length > 0 && remaining.length === 0) {
    warnings.push(
      `This removes every subnet on the ${meta ? meta.label : feature} allow list. ` +
        `An empty allow list denies all access to that surface.`
    );
  }

  const wideOpen = subnets.filter((s) => s === "0.0.0.0/0" || s === "::/0");
  if (wideOpen.length) {
    warnings.push(
      `Removing ${wideOpen.join(", ")} closes access that is currently open to everything — ` +
        `make sure a narrower subnet covering you is already on the list.`
    );
  }

  return { warnings, remainingCount: remaining.length };
}

export function assessAddition({ subnets, envId }) {
  const warnings = [];

  // Anything non-public is already rejected by validation. What survives to
  // here and still deserves a second look is an unusually broad public range.
  const broad = subnets.filter((s) => {
    const prefix = Number(s.split("/")[1]);
    return s.includes(".") ? prefix < 16 : prefix < 32;
  });
  if (broad.length) {
    const counts = broad.map((s) => {
      const prefix = Number(s.split("/")[1]);
      const hosts = s.includes(".")
        ? Math.pow(2, 32 - prefix).toLocaleString()
        : `2^${128 - prefix}`;
      return `${s} (~${hosts} addresses)`;
    });
    warnings.push(
      `Unusually broad range(s): ${counts.join(", ")}. Confirm this is intentional.`
    );
  }

  if (ENVIRONMENTS[envId] && ENVIRONMENTS[envId].restricted && broad.length) {
    warnings.push(
      "Broad allow list entries in a FedRAMP/IL2 environment are likely to draw an audit finding."
    );
  }

  return { warnings };
}
