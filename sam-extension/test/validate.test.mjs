// Run: node test/validate.test.mjs
import {
  validateIpv4Cidr,
  validateIpv6Cidr,
  parseSubnetList,
  buildIpAllowListUrl,
  buildCurl,
  assessRemoval,
  featureAvailable,
  featuresForExperience,
} from "../acs.js";

let pass = 0;
const failures = [];

function ok(name, cond, detail = "") {
  if (cond) pass++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

function accepts(input, expected) {
  const r = validateIpv4Cidr(input);
  ok(`accepts ${input}`, r.ok && r.value === expected, r.ok ? `got ${r.value}, want ${expected}` : r.error);
}

function rejects(input, mustMention) {
  const r = validateIpv4Cidr(input);
  ok(
    `rejects ${input}`,
    !r.ok && (!mustMention || r.error.includes(mustMention)),
    r.ok ? `unexpectedly accepted as ${r.value}` : `error was: ${r.error}`
  );
}

/* ── public IPv4 accepted ───────────────────────────────────────── */
accepts("52.24.108.7/32", "52.24.108.7/32");
accepts("34.210.15.0/24", "34.210.15.0/24");
accepts("8.8.8.8/32", "8.8.8.8/32");
accepts("1.1.1.0/24", "1.1.1.0/24");
accepts("34.210.15.7/24", "34.210.15.0/24");     // host bits normalized

/* ── private / reserved IPv4 rejected ───────────────────────────── */
rejects("10.0.10.6/32", "10.0.0.0/8");
rejects("192.168.4.0/24", "192.168.0.0/16");
rejects("172.16.5.0/24", "172.16.0.0/12");
rejects("172.31.255.0/24", "172.16.0.0/12");
rejects("127.0.0.1/32", "Loopback");
rejects("169.254.1.1/32", "Link-local");
rejects("100.64.0.0/10", "carrier-grade NAT");
rejects("192.0.2.5/32", "TEST-NET-1");
rejects("198.51.100.5/32", "TEST-NET-2");
rejects("203.0.113.5/32", "TEST-NET-3");
rejects("224.0.0.1/32", "Multicast");
rejects("255.255.255.255/32", "Reserved");
rejects("0.0.0.0/8", "This network");
rejects("0.0.0.0/0", "entire internet");

/* ── the subtle one: partial overlap with a reserved block ──────── */
rejects("10.0.0.0/7", "overlaps");   // 10/7 spans 10.x (private) and 11.x (public)
rejects("172.16.0.0/11", "overlaps");
ok(
  "172.32.0.0/12 is public (just outside RFC1918)",
  validateIpv4Cidr("172.32.0.0/12").ok
);
ok("11.0.0.0/8 is public (adjacent to 10/8)", validateIpv4Cidr("11.0.0.0/8").ok);
ok("172.15.0.0/16 is public", validateIpv4Cidr("172.15.0.0/16").ok);

/* ── malformed IPv4 ─────────────────────────────────────────────── */
rejects("1.2.3", "four octets");
rejects("1.2.3.4.5", "four octets");
/* ── the prefix length is mandatory ─────────────────────────────── */
// A bare address must not be silently promoted to /32: the operator has to
// state the size of the boundary change themselves.
rejects("52.24.108.7", "missing a prefix length");
rejects("52.24.108.7", "52.24.108.7/32");        // error suggests the fix
rejects("8.8.8.8", "missing a prefix length");
ok("bare address is rejected in a batch", (() => {
  const r = parseSubnetList("8.8.8.8, 1.1.1.0/24", "v4");
  return r.errors.length === 1 && r.valid.length === 1 && r.valid[0] === "1.1.1.0/24";
})());
ok("bare IPv6 is rejected too", (() => {
  const r = validateIpv6Cidr("2600:1f14:a3c::");
  return !r.ok && r.error.includes("missing a prefix length") && r.error.includes("/128");
})());

rejects("256.1.1.1/32", "out of range");
rejects("1.2.3.4/33", "maximum is /32");
rejects("01.2.3.4/32", "leading zero");
rejects("a.b.c.d", "non-numeric");
rejects("1.2.3.4/24/8", "more than one");
rejects("", "Empty");

/* ── IPv6 ───────────────────────────────────────────────────────── */
function v6ok(input, expected) {
  const r = validateIpv6Cidr(input);
  ok(`v6 accepts ${input}`, r.ok && r.value === expected, r.ok ? `got ${r.value}` : r.error);
}
function v6bad(input, mustMention) {
  const r = validateIpv6Cidr(input);
  ok(`v6 rejects ${input}`, !r.ok && (!mustMention || r.error.includes(mustMention)),
    r.ok ? `unexpectedly accepted as ${r.value}` : `error was: ${r.error}`);
}

v6ok("2600:1f14:a3c::/48", "2600:1f14:a3c::/48");
v6ok("2001:4860:4860::8888/128", "2001:4860:4860::8888/128");
v6ok("2600:1f14:a3c::/128", "2600:1f14:a3c::/128");
v6bad("fe80::1/64", "Link-local");
v6bad("fc00::/7", "Unique local");
v6bad("fd12:3456::/32", "Unique local");   // fd.. is inside fc00::/7
v6bad("::1/128", "Loopback");
v6bad("2001:db8::/32", "Documentation");
v6bad("ff02::1/128", "Multicast");
v6bad("::/0", "entire internet");
v6bad("gggg::1", "not valid in IPv6");
v6bad("2600::1/129", "maximum is /128");
v6bad("2600:::1", "not a valid IPv6");

/* ── batch parsing ──────────────────────────────────────────────── */
const batch = parseSubnetList("52.24.108.7/32, 10.0.0.5/32\n8.8.8.8/32", "v4");
ok("batch keeps valid entries", batch.valid.length === 2, JSON.stringify(batch.valid));
ok("batch reports the private one", batch.errors.length === 1, JSON.stringify(batch.errors));

const dedup = parseSubnetList("8.8.8.8/32, 8.8.8.8/32, 8.8.8.8", "v4");
ok("batch de-duplicates", dedup.valid.length === 1, JSON.stringify(dedup.valid));

const normWarn = parseSubnetList("34.210.15.7/24", "v4");
ok("batch surfaces normalization warning", normWarn.warnings.length === 1, JSON.stringify(normWarn.warnings));

/* ── URL routing ────────────────────────────────────────────────── */
ok(
  "govcloud url",
  buildIpAllowListUrl({ envId: "govcloud_il2", stack: "csms-2io6tw-47150", feature: "s2s", ipVersion: "v4" }) ===
    "https://admin.splunkcloudgc.com/csms-2io6tw-47150/adminconfig/v2/access/s2s/ipallowlists"
);
ok(
  "commercial url",
  buildIpAllowListUrl({ envId: "commercial", stack: "acme", feature: "search-ui", ipVersion: "v4" }) ===
    "https://admin.splunk.com/acme/adminconfig/v2/access/search-ui/ipallowlists"
);
ok(
  "ipv6 url suffix",
  buildIpAllowListUrl({ envId: "govcloud_il2", stack: "acme", feature: "hec", ipVersion: "v6" }).endsWith(
    "/access/hec/ipallowlists-v6"
  )
);
// ACS serves staging stacks from staging.admin.* hosts with an otherwise
// identical signature. (Dev stacks are not supported by ACS at all.)
ok(
  "govcloud staging url",
  buildIpAllowListUrl({ envId: "govcloud_il2_staging", stack: "csms-2io6tw-47150", feature: "s2s", ipVersion: "v4" }) ===
    "https://staging.admin.splunkcloudgc.com/csms-2io6tw-47150/adminconfig/v2/access/s2s/ipallowlists"
);
ok(
  "commercial staging url",
  buildIpAllowListUrl({ envId: "commercial_staging", stack: "acme", feature: "search-ui", ipVersion: "v4" }) ===
    "https://staging.admin.splunk.com/acme/adminconfig/v2/access/search-ui/ipallowlists"
);
ok(
  "staging path identical to production apart from host",
  buildIpAllowListUrl({ envId: "commercial_staging", stack: "acme", feature: "hec", ipVersion: "v6" }) ===
    buildIpAllowListUrl({ envId: "commercial", stack: "acme", feature: "hec", ipVersion: "v6" }).replace(
      "https://admin.", "https://staging.admin."
    )
);
// Inherited Object.prototype keys must not pass as environments: a bare
// ENVIRONMENTS[id] answers truthy for these and yields an undefined host.
for (const proto of ["__proto__", "constructor", "toString"]) {
  ok(`environment "${proto}" rejected`, (() => {
    try {
      buildIpAllowListUrl({ envId: proto, stack: "acme", feature: "acs", ipVersion: "v4" });
      return false;
    } catch (e) {
      return e.message.includes("Unknown environment");
    }
  })());
}

ok("stack with braces rejected", (() => {
  try { buildIpAllowListUrl({ envId: "commercial", stack: "{stack}", feature: "s2s", ipVersion: "v4" }); return false; }
  catch (e) { return e.message.includes("looks invalid"); }
})());
ok("empty stack rejected", (() => {
  try { buildIpAllowListUrl({ envId: "commercial", stack: "  ", feature: "s2s", ipVersion: "v4" }); return false; }
  catch (e) { return e.message.includes("required"); }
})());

/* ── curl parity with the documented runbook ────────────────────── */
const curlGet = buildCurl({ envId: "govcloud_il2", stack: "acme", feature: "s2s", ipVersion: "v4", method: "GET" });
ok("curl GET shape", curlGet.startsWith("curl https://admin.splunkcloudgc.com/acme/") && curlGet.includes("Authorization: Bearer"), curlGet);

const curlPost = buildCurl({ envId: "govcloud_il2", stack: "acme", feature: "search-ui", ipVersion: "v4", method: "POST", subnets: ["8.8.8.8/32"] });
ok("curl POST has data + content-type", curlPost.includes("-X POST") && curlPost.includes("Content-Type: application/json") && curlPost.includes('"subnets":["8.8.8.8/32"]'), curlPost);

/* ── removal risk assessment ────────────────────────────────────── */
const emptying = assessRemoval({ feature: "search-ui", subnets: ["8.8.8.8/32"], currentList: ["8.8.8.8/32"] });
ok("warns when emptying the list", emptying.warnings.some((w) => w.includes("every subnet")), JSON.stringify(emptying.warnings));
ok("counts remaining", emptying.remainingCount === 0);

const partial = assessRemoval({ feature: "hec", subnets: ["8.8.8.8/32"], currentList: ["8.8.8.8/32", "1.1.1.1/32"] });
ok("no empty-list warning on partial removal", !partial.warnings.some((w) => w.includes("every subnet")));

/* ── feature availability per experience ────────────────────────── */
ok("IDM UI is hidden on Victoria", !featureAvailable("idm-ui", "victoria"));
ok("IDM API is hidden on Victoria", !featureAvailable("idm-api", "victoria"));
ok("IDM UI stays on Classic", featureAvailable("idm-ui", "classic"));
ok("IDM API stays on Classic", featureAvailable("idm-api", "classic"));
ok(
  "non-IDM features are on both experiences",
  ["search-api", "search-ui", "hec", "s2s", "acs"].every(
    (id) => featureAvailable(id, "victoria") && featureAvailable(id, "classic")
  )
);
ok("an unknown experience falls back to Classic", featureAvailable("idm-ui", "__proto__"));
ok("an unknown feature is never available", !featureAvailable("nope", "classic"));
ok(
  "Victoria's feature list drops both IDM entries",
  featuresForExperience("victoria").length === featuresForExperience("classic").length - 2 &&
    !featuresForExperience("victoria").some((f) => f.id.startsWith("idm-"))
);

/* ── report ─────────────────────────────────────────────────────── */
console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log("  FAIL  " + f);
  process.exit(1);
}
console.log("All validator, routing, and curl-parity checks passed.");
