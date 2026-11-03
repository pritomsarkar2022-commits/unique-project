import { e, phpTrim } from '../support.mjs';
import { homeChipTpl, homeRowTpl } from './pages.gen.mjs';

/**
 * The two lists home.php builds from the registry: the chips in the tool card and the
 * rows of the supported-sites table.
 *
 * The grouping is not cosmetic. home.php buckets every host under the name of the
 * extractor that reads it, sorts each bucket, then sorts the buckets by reader name,
 * and shows one chip per bucket -- so a visitor sees `streamtape.com` and not
 * `cdn-a.streamtape.net`, and the table says "and 8 more domains" instead of listing
 * forty-four hosts. All of that is reproduced here from the php, including the
 * comparison order, because a table whose rows shuffled would be a visible change.
 */

/** home.php's $tldRank: which suffix reads as the "real" site when one host has siblings. */
const TLD_RANK = {
  com: 0, net: 1, to: 2, io: 3, gs: 4, me: 5, org: 6, site: 7,
  live: 8, click: 9, ch: 10, co: 11, ps: 12, sx: 13, pe: 14, info: 15, pro: 16,
};

/** Readers that only ever hand back a single mp4, which is what colours the badge. */
const MP4_ONLY = ['streamtape', 'cloudfam', 'mxdrop', 'xfs'];

function coreOf(host) {
  const p = String(host).split('.');
  return phpToLower(p.length >= 2 ? p[p.length - 2] : host);
}

function tldOf(host) {
  const p = String(host).split('.');
  return phpToLower(p[p.length - 1] ?? host);
}

/** strtolower() on the byte-per-char string model the port uses for php strings. */
function phpToLower(s) {
  return String(s).replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * @param {Record<string,string>|Map<string,string>} hosts host => reader name, in the
 *   order knownHosts() returns them (php ksorts there, so insertion order is sorted)
 * @returns {{chipHosts: string[], groups: Array<{reader:string, hosts:string[]}>}}
 */
export function groupHosts(hosts) {
  const entries = hosts instanceof Map ? [...hosts.entries()] : Object.entries(hosts ?? {});
  const order = [];
  const byReader = new Map();
  for (const [host, reader] of entries) {
    if (!byReader.has(reader)) {
      byReader.set(reader, []);
      order.push(reader);
    }
    byReader.get(reader).push(host);
  }

  // usort is stable since php 8, and the comparator returns 0 for equal rank, so the
  // registry's own order survives inside each tie. Array.prototype.sort is stable too.
  for (const reader of order) {
    const list = byReader.get(reader);
    list.sort((a, b) => {
      const sa = coreOf(a) === reader ? 0 : 1;
      const sb = coreOf(b) === reader ? 0 : 1;
      if (sa !== sb) {
        return sa - sb;
      }
      const ra = TLD_RANK[tldOf(a)] ?? 99;
      const rb = TLD_RANK[tldOf(b)] ?? 99;
      if (ra !== rb) {
        return ra - rb;
      }
      return strcmp(a, b);
    });
  }

  order.sort(ksortCompare);
  const groups = order.map((reader) => ({ reader, hosts: byReader.get(reader) }));
  return { chipHosts: groups.map((g) => g.hosts[0]), groups };
}

/** strcmp() over bytes; the port carries php strings one js char per byte. */
function strcmp(a, b) {
  const x = String(a);
  const y = String(b);
  if (x === y) {
    return 0;
  }
  return x < y ? -1 : 1;
}

/**
 * ksort() with the default SORT_REGULAR: two numeric strings compare as numbers, and
 * everything else compares byte-wise. Reader names are words, so only the second arm
 * ever fires -- but a name is data from an extractor, not a constant.
 */
function ksortCompare(a, b) {
  if (isNumericString(a) && isNumericString(b)) {
    const x = Number(a);
    const y = Number(b);
    return x === y ? 0 : (x < y ? -1 : 1);
  }
  return strcmp(a, b);
}

function isNumericString(s) {
  return /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(String(s));
}

/** The chips, exactly as the foreach in home.php emits them. */
export function renderChips(chipHosts) {
  const lines = chipHosts.map((host) => homeChipTpl.replace('{{HOST}}', e(host)));
  return lines.length === 0 ? '' : lines.join('\n') + '\n';
}

/** The table rows, one group per reader, with the alias span only for siblings. */
export function renderRows(groups) {
  const lines = [];
  for (const group of groups) {
    const kind = MP4_ONLY.includes(group.reader) ? 'MP4' : 'MP4 or HLS';
    const extra = group.hosts.length - 1;
    // A lone host gets no alias span at all -- and not even the whitespace around it,
    // because php emits none between the two inline tags.
    const alias = extra > 0 ? '<span class="alias">and ' + extra + ' more domains</span>' : '';
    lines.push(
      homeRowTpl
        .split('\n')
        .map((line) =>
          line
            .replace('{{HOST}}', e(group.hosts[0]))
            .replaceAll('{{ALIAS}}', alias)
            .replace('{{BADGE}}', kind === 'MP4' ? 'badge badge-ok' : 'badge')
            .replace('{{KIND}}', kind))
        .join('\n'),
    );
  }
  return lines.length === 0 ? '' : lines.join('\n') + '\n';
}

export { homeChipTpl as CHIP_LINE, homeRowTpl as ROW_BLOCK };
