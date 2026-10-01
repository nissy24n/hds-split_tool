#!/usr/bin/env node
//
// hds-split --- X68000 SCSI HDD イメージ (.hds) をパーティション単位の .hds に分割する
//
// Node.js 14 以降
//
import {
	openSync, closeSync, readSync, writeSync, fstatSync, ftruncateSync,
	existsSync, mkdirSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

const PHYS = 512;
const PT_SECTOR = 4;
const PT_OFFSET = PT_SECTOR * PHYS;
const UNIT = 1024;
const MAX_PARTS = 15;
const COPY_BUF = 4 * 1024 * 1024;

const SEC0_MAGIC = 'X68SCSI1';
const PT_MAGIC = 'X68K';

function readAt(fd, offset, length) {
	const buf = Buffer.alloc(length);
	let got = 0;
	while (got < length) {
		const n = readSync(fd, buf, got, length - got, offset + got);
		if (n === 0) break;
		got += n;
	}
	if (got < length) {
		throw new Error(`イメージが短すぎます: offset 0x${offset.toString(16)} から ${length} バイト読み取れません`);
	}
	return buf;
}

function writeAll(fd, buf, offset) {
	let done = 0;
	while (done < buf.length) {
		done += writeSync(fd, buf, done, buf.length - done, offset + done);
	}
}

const ascii = (buf) => buf.toString('latin1');
const trimName = (buf) => ascii(buf).replace(/[\0\s]+$/, '');

function parseBpb(buf) {
	const totalSectors16 = buf.readUInt16BE(0x1a);
	return {
		hasBra: buf[0] === 0x60,
		oem: trimName(buf.subarray(0x02, 0x12)),
		bytesPerSector: buf.readUInt16BE(0x12),
		sectorsPerCluster: buf[0x14],
		numFats: buf[0x15],
		reservedSectors: buf.readUInt16BE(0x16),
		rootEntries: buf.readUInt16BE(0x18),
		totalSectors: totalSectors16 !== 0 ? totalSectors16 : buf.readUInt32BE(0x1e),
		mediaDescriptor: buf[0x1c],
		sectorsPerFat: buf[0x1d],
		partitionStart: buf.readUInt32BE(0x22),
	};
}

function fsLayout(bpb) {
	const rootSectors = Math.ceil((bpb.rootEntries * 32) / bpb.bytesPerSector);
	const fat1 = bpb.reservedSectors;
	const root = fat1 + bpb.numFats * bpb.sectorsPerFat;
	const data = root + rootSectors;
	const clusters = Math.floor((bpb.totalSectors - data) / bpb.sectorsPerCluster);
	return { fat1, root, rootSectors, data, clusters };
}

function readFatUsage(fd, part) {
	const lay = fsLayout(part.bpb);
	const fat = readAt(fd, part.byteStart + lay.fat1 * UNIT, part.bpb.sectorsPerFat * UNIT);
	let used = 0;
	let free = 0;
	let bad = 0;
	for (let c = 2; c < lay.clusters + 2; c++) {
		const v = fat.readUInt16BE(c * 2);
		if (v === 0) free++;
		else if (v === 0xfff7) bad++;
		else used++;
	}
	const kb = (n) => (n * part.bpb.sectorsPerCluster * part.bpb.bytesPerSector) / 1024;
	return { clusters: lay.clusters, usedKb: kb(used), freeKb: kb(free), badKb: kb(bad) };
}

function readRootDir(fd, part) {
	const lay = fsLayout(part.bpb);
	const buf = readAt(fd, part.byteStart + lay.root * UNIT, lay.rootSectors * UNIT);
	const entries = [];
	let deleted = 0;
	for (let off = 0; off < part.bpb.rootEntries * 32; off += 32) {
		const e = buf.subarray(off, off + 32);
		if (e[0] === 0x00) break;
		if (e[0] === 0xe5) { deleted++; continue; }
		const name = (ascii(e.subarray(0, 8)) + ascii(e.subarray(0x0c, 0x16))).replace(/[\0\s]+$/, '');
		const ext = trimName(e.subarray(8, 11));
		const time = e.readUInt16LE(0x16);
		const date = e.readUInt16LE(0x18);
		entries.push({
			name, ext,
			attr: e[0x0b],
			cluster: e.readUInt16LE(0x1a),
			size: e.readUInt32LE(0x1c),
			stamp: `${String(1980 + (date >> 9)).slice(2)}-${String((date >> 5) & 0x0f).padStart(2, '0')}-${String(date & 0x1f).padStart(2, '0')} ` +
				`${String(time >> 11).padStart(2, '0')}:${String((time >> 5) & 0x3f).padStart(2, '0')}:${String((time & 0x1f) * 2).padStart(2, '0')}`,
		});
	}
	return { entries, deleted };
}

function openImage(path) {
	const fd = openSync(path, 'r');
	const size = fstatSync(fd).size;
	const warnings = [];

	if (size % PHYS !== 0) {
		warnings.push(`ファイルサイズ ${size} が ${PHYS} バイトの倍数ではありません`);
	}
	if (size < PT_OFFSET + PHYS) {
		throw new Error('ファイルが小さすぎてパーティションテーブルがありません');
	}

	const sec0 = readAt(fd, 0, PHYS);
	const magic = ascii(sec0.subarray(0, 8));
	const declSectorSize = sec0.readUInt16BE(0x08);
	const declLastLba = sec0.readUInt32BE(0x0a);
	const blocks = Math.floor(size / PHYS);
	const header = {
		magic,
		isHds: magic === SEC0_MAGIC,
		declSectorSize,
		declLastLba,
		capacityFieldVerified: magic === SEC0_MAGIC && declSectorSize === PHYS && declLastLba === blocks - 1,
		idString: ascii(sec0.subarray(0x10, 0x34)).replace(/\0[\s\S]*$/, '').trim(),
	};
	if (!header.isHds) {
		warnings.push(`sector 0 のマジックが "${SEC0_MAGIC}" ではありません (読めた値: ${JSON.stringify(magic)})`);
	} else if (declSectorSize !== PHYS) {
		warnings.push(`sector 0 のセクタサイズ欄が ${declSectorSize} です (このツールは 512 のみ対応)`);
	} else if (!header.capacityFieldVerified) {
		warnings.push(`sector 0 +0x0a の値 (${declLastLba}) が「総ブロック数 - 1」(${blocks - 1}) と一致しません。容量欄の書き換えは行いません`);
	}

	const ptSec = readAt(fd, PT_OFFSET, PHYS);
	if (ascii(ptSec.subarray(0, 4)) !== PT_MAGIC) {
		throw new Error(`sector ${PT_SECTOR} (0x${PT_OFFSET.toString(16)}) に "${PT_MAGIC}" マジックがありません。HDS イメージではないか、HDF (SASI, 0x400) の可能性があります`);
	}
	const table = {
		usedEnd: ptSec.readUInt32BE(0x04),
		lastSector: ptSec.readUInt32BE(0x08),
		lastSector2: ptSec.readUInt32BE(0x0c),
	};

	const partitions = [];
	for (let i = 0; i < MAX_PARTS; i++) {
		const off = 0x10 + i * 16;
		const raw = Buffer.from(ptSec.subarray(off, off + 16));
		if (raw[0] === 0x00) continue;
		const flags = raw[0x08];
		const start = raw.readUInt32BE(0x08) & 0x00ffffff;
		const length = raw.readUInt32BE(0x0c);
		const p = {
			slot: i + 1,
			raw,
			name: trimName(raw.subarray(0, 8)),
			flags,
			start,
			length,
			byteStart: start * UNIT,
			byteLength: length * UNIT,
			bpb: null,
			problems: [],
		};
		if (length === 0) {
			p.problems.push('長さが 0 です');
		}
		if (p.byteStart + p.byteLength > size) {
			p.problems.push(`イメージ末尾を超えています (必要 ${p.byteStart + p.byteLength} B / 実ファイル ${size} B)`);
		}
		if (p.byteStart < PT_OFFSET + PHYS) {
			p.problems.push('開始位置がパーティションテーブルと重なっています');
		}
		if (p.problems.length === 0) {
			try {
				p.bpb = parseBpb(readAt(fd, p.byteStart, UNIT));
				if (p.bpb.bytesPerSector !== UNIT) {
					p.problems.push(`先頭が Human68k の BPB に見えません (bytes_per_sector=${p.bpb.bytesPerSector})`);
				} else if (p.bpb.partitionStart !== p.start) {
					p.problems.push(`BPB +0x22 の開始セクタ ${p.bpb.partitionStart} がテーブルの開始セクタ ${p.start} と一致しません。意味が判断できないため分割しません`);
				}
			} catch (e) {
				p.problems.push(`BPB 読み取り失敗: ${e.message}`);
			}
		}
		partitions.push(p);
	}
	if (partitions.length === 0) {
		throw new Error('有効なパーティションエントリが見つかりません');
	}

	const sorted = [...partitions].sort((a, b) => a.start - b.start);
	for (let i = 1; i < sorted.length; i++) {
		const prev = sorted[i - 1];
		const cur = sorted[i];
		if (prev.start + prev.length > cur.start) {
			cur.problems.push(`スロット ${prev.slot} (${prev.name}) と領域が重なっています`);
		}
	}

	return { fd, path, size, blocks, total1024: Math.floor(size / UNIT), header, table, partitions, warnings };
}

const fmtBytes = (n) => {
	const u = ['B', 'KB', 'MB', 'GB', 'TB'];
	let i = 0;
	let v = n;
	while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
	return `${i === 0 ? v : v.toFixed(v < 10 ? 2 : 1)} ${u[i]}`;
};
const hex8 = (n) => `0x${n.toString(16).padStart(8, '0')}`;

function printInfo(img, showDir = false) {
	console.log(`ファイル   : ${img.path}`);
	console.log(`サイズ     : ${img.size} B (${fmtBytes(img.size)}) = ${img.blocks} ブロック (512 B)`);
	console.log(`sector 0   : magic=${JSON.stringify(img.header.magic)} sector_size=${img.header.declSectorSize} last_lba=${img.header.declLastLba}${img.header.capacityFieldVerified ? ' (容量欄として整合)' : ''}`);
	console.log(`識別文字列 : ${JSON.stringify(img.header.idString)}`);
	console.log(`テーブル   : used_end=${img.table.usedEnd} last=${img.table.lastSector} last2=${img.table.lastSector2} (単位 ${UNIT} B)`);
	console.log('');
	console.log('スロット 名前               開始(1024B)            長さ(1024B)  サイズ      バイト範囲');
	console.log('------- ------------------ ---------------------- ------------ ----------- -----------------------');
	for (const p of img.partitions) {
		console.log(
			`${String(p.slot).padStart(5)}   ` +
			`${p.name.padEnd(18)} ` +
			`${String(p.start).padStart(11)} ${hex8(p.start)} ` +
			`${String(p.length).padStart(11)} ` +
			`${fmtBytes(p.byteLength).padStart(10)}  ` +
			`${hex8(p.byteStart)}-${hex8(p.byteStart + p.byteLength)}`
		);
		if (p.bpb) {
			const b = p.bpb;
			console.log(`        BPB OEM=${JSON.stringify(b.oem)} logical=${b.bytesPerSector}B spc=${b.sectorsPerCluster} fats=${b.numFats} spf=${b.sectorsPerFat} root=${b.rootEntries} total=${b.totalSectors} media=0x${b.mediaDescriptor.toString(16)} start(+0x22)=${b.partitionStart}`);
		}
		for (const w of p.problems) {
			console.log(`        ! ${w}`);
		}
		if (showDir && p.bpb && p.problems.length === 0) {
			const u = readFatUsage(img.fd, p);
			const { entries, deleted } = readRootDir(img.fd, p);
			console.log(`        ルート ${entries.length} エントリ` +
				(deleted > 0 ? ` (削除済み ${deleted} 個)` : '') +
				`  使用中 ${u.usedKb}K / 使用可能 ${u.freeKb}K` +
				(u.badKb > 0 ? ` / 不良 ${u.badKb}K` : ''));
			for (const e of entries) {
				const kind = (e.attr & 0x08) ? '<vol>' : (e.attr & 0x10) ? '<dir>' : String(e.size);
				console.log(`          ${e.name.padEnd(18)} ${e.ext.padEnd(3)} ${kind.padStart(10)}  ${e.stamp}  attr=0x${e.attr.toString(16).padStart(2, '0')}`);
			}
		}
	}
	for (const w of img.warnings) {
		console.log(`\n警告: ${w}`);
	}
}

function sanitize(name, slot) {
	const s = name.replace(/[^0-9A-Za-z._-]/g, '_').replace(/^[._]+/, '');
	return s.length > 0 ? s : `part${slot}`;
}

function buildHeaderArea(img, part, headerUnits, dataStartUnits, opts) {
	const area = readAt(img.fd, 0, headerUnits * UNIT);
	const outTotal1024 = dataStartUnits + part.length;

	if (img.header.capacityFieldVerified) {
		area.writeUInt32BE(outTotal1024 * (UNIT / PHYS) - 1, 0x0a);
	}

	const pt = Buffer.alloc(PHYS);
	pt.write(PT_MAGIC, 0, 'latin1');
	pt.writeUInt32BE(dataStartUnits + part.length, 0x04);
	pt.writeUInt32BE(outTotal1024 - 1, 0x08);
	pt.writeUInt32BE(outTotal1024 - 1, 0x0c);
	const entry = Buffer.from(part.raw);
	const flags = opts.entryFlag ?? 0x00;
	entry.writeUInt32BE((flags << 24) | dataStartUnits, 0x08);
	entry.copy(pt, 0x10);
	pt.copy(area, PT_OFFSET);

	return area;
}

function patchBpbStart(dstFd, dataOffset, oldStart, newStart) {
	const sec = Buffer.alloc(PHYS);
	let got = 0;
	while (got < PHYS) {
		const n = readSync(dstFd, sec, got, PHYS - got, dataOffset + got);
		if (n === 0) throw new Error('BPB の読み戻しに失敗しました');
		got += n;
	}
	const found = sec.readUInt32BE(0x22);
	if (found !== oldStart) {
		return { patched: false, found };
	}
	sec.writeUInt32BE(newStart, 0x22);
	writeAll(dstFd, sec, dataOffset);
	return { patched: true, found };
}

function copyRange(srcFd, dstFd, srcOffset, dstOffset, length, onProgress) {
	const buf = Buffer.alloc(Math.min(COPY_BUF, Math.max(length, PHYS)));
	let done = 0;
	while (done < length) {
		const want = Math.min(buf.length, length - done);
		let got = 0;
		while (got < want) {
			const n = readSync(srcFd, buf, got, want - got, srcOffset + done + got);
			if (n === 0) throw new Error('コピー中に想定外の EOF に達しました');
			got += n;
		}
		writeAll(dstFd, buf.subarray(0, got), dstOffset + done);
		done += got;
		if (onProgress) onProgress(done, length);
	}
}

function splitOne(img, part, opts) {
	const headerUnits = opts.reserveUnits;
	const dataStartUnits = opts.keepStart ? part.start : headerUnits;
	const outTotal1024 = dataStartUnits + part.length;
	const outSize = outTotal1024 * UNIT;

	const stem = opts.prefix ?? basename(img.path).replace(/\.[^.]*$/, '');
	const outPath = join(opts.outDir, `${stem}-p${part.slot}-${sanitize(part.name, part.slot)}.hds`);

	if (existsSync(outPath) && !opts.overwrite) {
		throw new Error(`${outPath} が既に存在します (--overwrite で上書き)`);
	}

	console.log(`\n[スロット ${part.slot}] ${part.name || '(無名)'} -> ${outPath}`);
	console.log(`  データ ${hex8(part.byteStart)} +${part.byteLength} B (${fmtBytes(part.byteLength)})` +
		`  出力 ${outSize} B (${fmtBytes(outSize)})  開始セクタ ${part.start} -> ${dataStartUnits}`);

	if (opts.dryRun) return { outPath, outSize, ok: null };

	const area = buildHeaderArea(img, part, headerUnits, dataStartUnits, opts);
	const dstFd = openSync(outPath, opts.overwrite ? 'w+' : 'wx+');
	try {
		writeAll(dstFd, area, 0);
		let lastPct = -1;
		copyRange(img.fd, dstFd, part.byteStart, dataStartUnits * UNIT, part.byteLength, (done, total) => {
			if (!process.stderr.isTTY) return;
			const pct = Math.floor((done / total) * 100);
			if (pct !== lastPct) {
				lastPct = pct;
				process.stderr.write(`\r  コピー中 ${pct}% (${fmtBytes(done)}/${fmtBytes(total)})    `);
			}
		});
		if (process.stderr.isTTY) process.stderr.write(`\r${' '.repeat(50)}\r`);
		const newFlags = opts.entryFlag ?? 0x00;
		if (newFlags !== part.flags) {
			console.log(`  エントリのフラグを 0x${part.flags.toString(16).padStart(2, '0')} -> 0x${newFlags.toString(16).padStart(2, '0')} にしました`);
		}
		if (dataStartUnits !== part.start) {
			const r = patchBpbStart(dstFd, dataStartUnits * UNIT, part.start, dataStartUnits);
			console.log(r.patched
				? `  BPB +0x22 の開始セクタを ${part.start} -> ${dataStartUnits} に書き換えました`
				: `  ! BPB +0x22 が ${r.found} で元の開始セクタ ${part.start} と違うため書き換えていません`);
		}
		ftruncateSync(dstFd, outSize);
	} finally {
		closeSync(dstFd);
	}

	const check = openImage(outPath);
	try {
		const only = check.partitions[0];
		const ok = check.partitions.length === 1 && only.length === part.length &&
			only.start === dataStartUnits && only.problems.length === 0;
		console.log(`  検証 ${ok ? 'OK' : '要確認'}: パーティション ${check.partitions.length} 個, ` +
			`開始 ${only?.start}, 長さ ${only?.length}` +
			(only?.bpb ? `, BPB +0x22 ${only.bpb.partitionStart}, OEM ${JSON.stringify(only.bpb.oem)}` : ''));
		for (const w of only?.problems ?? []) console.log(`  ! ${w}`);
		for (const w of check.warnings) console.log(`  警告: ${w}`);
		return { outPath, outSize, ok };
	} finally {
		closeSync(check.fd);
	}
}

function verifyAgainst(img, splitPath, opts) {
	const out = openImage(splitPath);
	try {
		if (out.partitions.length !== 1) {
			throw new Error(`${splitPath} のパーティションが ${out.partitions.length} 個あります (分割済みイメージを指定してください)`);
		}
		const target = out.partitions[0];
		let candidates = img.partitions.filter((p) => p.length === target.length);
		if (opts.only) {
			candidates = candidates.filter((p) => opts.only.includes(p.slot));
		}
		if (candidates.length === 0) {
			throw new Error(`長さ ${target.length} に一致するパーティションが元イメージにありません`);
		}

		console.log(`\n照合先: ${splitPath}`);
		console.log(`  パーティション: 開始 ${target.start}, 長さ ${target.length}, BPB +0x22 ${target.bpb?.partitionStart}`);

		let matched = null;
		for (const p of candidates) {
			const diff = compareData(img.fd, p, out.fd, target);
			console.log(`  元スロット ${p.slot} (開始 ${p.start}) との照合: ` +
				(diff === null ? '一致' : `不一致 (パーティション先頭から ${diff} バイト目、絶対 0x${(target.byteStart + diff).toString(16)})`));
			if (diff === null) matched = p;
		}
		if (matched) {
			console.log(`\n一致: 元スロット ${matched.slot} のデータと完全に同一です。`);
			return true;
		}
		console.log('\n不一致: どのパーティションとも一致しませんでした。' +
			'\n  元イメージが分割後に更新された / 分割時点のイメージが別物だった可能性があります。');
		return false;
	} finally {
		closeSync(out.fd);
	}
}

function compareData(aFd, aPart, bFd, bPart) {
	const length = aPart.byteLength;
	const bufA = Buffer.alloc(COPY_BUF);
	const bufB = Buffer.alloc(COPY_BUF);
	let done = 0;
	while (done < length) {
		const want = Math.min(COPY_BUF, length - done);
		const readInto = (fd, buf, base) => {
			let got = 0;
			while (got < want) {
				const n = readSync(fd, buf, got, want - got, base + done + got);
				if (n === 0) throw new Error('照合中に想定外の EOF');
				got += n;
			}
		};
		readInto(aFd, bufA, aPart.byteStart);
		readInto(bFd, bufB, bPart.byteStart);
		if (done === 0) {
			bufB.writeUInt32BE(bufA.readUInt32BE(0x22), 0x22);
		}
		for (let i = 0; i < want; i++) {
			if (bufA[i] !== bufB[i]) return done + i;
		}
		done += want;
	}
	return null;
}

const USAGE = `hds-split — X68000 SCSI HDD イメージ (.hds) をパーティション単位に分割する

使い方:
  node hds-split.mjs list   <image.hds> [--dir]
  node hds-split.mjs split  <image.hds> [オプション]
  node hds-split.mjs verify <image.hds> <分割後.hds>

オプション (split):
  -o, --out-dir <dir>  出力先ディレクトリ (既定: 入力ファイルと同じ場所)
      --prefix <name>  出力ファイル名の先頭 (既定: 入力ファイル名から拡張子を除いたもの)
      --only <1,3>     指定したスロットのみ出力する (list に表示されるスロット番号)
      --reserve <n>    予約領域のサイズを 1024 B 単位で指定する
      --keep-start     パーティションの開始セクタを元の値のまま保持する
      --entry-flag <n> パーティションエントリのフラグバイト (+0x08) を指定値にする
      --overwrite      既存の出力ファイルを上書きする
      --dry-run        書き込まずに出力予定の内容だけ表示する
  -h, --help           このヘルプを表示する

オプション (list):
      --dir            各パーティションのルートディレクトリと使用量も表示する

verify は分割後のイメージが元イメージのどのパーティションと
バイト単位で一致するかを確認する (BPB +0x22 の 4 バイトを除く)。

出力される .hds はそれぞれ 1 パーティションだけを持つ独立したイメージで、
sector 0 の容量欄と sector 4 のパーティションテーブルを書き換えてあります。
`;

function parseArgs(argv) {
	const opts = {
		cmd: null, image: null, splitImage: null, showDir: false,
		outDir: null, prefix: null, only: null,
		reserveUnits: null, keepStart: false, overwrite: false, dryRun: false, entryFlag: null,
	};
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => {
			if (i + 1 >= argv.length) throw new Error(`${a} に値が必要です`);
			return argv[++i];
		};
		switch (a) {
			case '-h': case '--help': console.log(USAGE); process.exit(0); break;
			case '-o': case '--out-dir': opts.outDir = next(); break;
			case '--prefix': opts.prefix = next(); break;
			case '--only':
				opts.only = next().split(',').map((s) => {
					const n = Number.parseInt(s.trim(), 10);
					if (!Number.isInteger(n)) throw new Error(`--only の値が不正です: ${s}`);
					return n;
				});
				break;
			case '--reserve': {
				const n = Number.parseInt(next(), 10);
				if (!Number.isInteger(n) || n <= 0) throw new Error('--reserve には正の整数を指定してください');
				opts.reserveUnits = n;
				break;
			}
			case '--dir': opts.showDir = true; break;
			case '--keep-start': opts.keepStart = true; break;
			case '--entry-flag': {
				const v = next();
				const n = Number.parseInt(v, v.startsWith('0x') ? 16 : 10);
				if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error('--entry-flag には 0〜255 を指定してください');
				opts.entryFlag = n;
				break;
			}
			case '--overwrite': opts.overwrite = true; break;
			case '--dry-run': opts.dryRun = true; break;
			default:
				if (a.startsWith('-')) throw new Error(`不明なオプション: ${a}`);
				rest.push(a);
		}
	}
	opts.cmd = rest[0] ?? null;
	opts.image = rest[1] ?? null;
	opts.splitImage = rest[2] ?? null;
	const max = opts.cmd === 'verify' ? 3 : 2;
	if (rest.length > max) throw new Error(`引数が多すぎます: ${rest.slice(max).join(' ')}`);
	return opts;
}

function main(argv) {
	const opts = parseArgs(argv);
	if (!opts.cmd || !opts.image) {
		console.log(USAGE);
		process.exit(opts.cmd ? 1 : 0);
	}
	if (!['list', 'split', 'verify'].includes(opts.cmd)) {
		throw new Error(`不明なコマンドです: ${opts.cmd} (list / split / verify)`);
	}
	if (opts.cmd === 'verify' && !opts.splitImage) {
		throw new Error('verify には元イメージと分割後イメージの 2 つを指定してください');
	}

	const img = openImage(opts.image);
	try {
		printInfo(img, opts.showDir);
		if (opts.cmd === 'list') return;
		if (opts.cmd === 'verify') {
			if (!verifyAgainst(img, opts.splitImage, opts)) process.exitCode = 2;
			return;
		}

		let targets = img.partitions;
		if (opts.only) {
			targets = opts.only.map((slot) => {
				const p = img.partitions.find((q) => q.slot === slot);
				if (!p) throw new Error(`スロット ${slot} のパーティションはありません`);
				return p;
			});
		}
		const bad = targets.filter((p) => p.problems.length > 0);
		if (bad.length > 0) {
			throw new Error(`問題のあるパーティションは分割できません: スロット ${bad.map((p) => p.slot).join(', ')}`);
		}

		const minStart = Math.min(...img.partitions.map((p) => p.start));
		const reserveUnits = opts.reserveUnits ?? minStart;
		if (reserveUnits * UNIT < PT_OFFSET + PHYS) {
			throw new Error(`予約領域が小さすぎます (${reserveUnits} x ${UNIT} B)。パーティションテーブルを置けません`);
		}
		if (reserveUnits > minStart) {
			throw new Error(`--reserve ${reserveUnits} は元イメージの最初のパーティション開始位置 ${minStart} より大きいため、予約領域を複製できません`);
		}

		const outDir = opts.outDir ?? dirname(opts.image);
		if (!opts.dryRun && !existsSync(outDir)) mkdirSync(outDir, { recursive: true });

		const results = [];
		for (const p of targets) {
			results.push(splitOne(img, p, { ...opts, outDir, reserveUnits }));
		}
		const ng = results.filter((r) => r.ok === false).length;
		console.log(`\n${results.length} 個のイメージを${opts.dryRun ? '出力する予定です (--dry-run)' : '書き出しました'}。` +
			(ng > 0 ? ` うち ${ng} 個は検証で要確認です。` : ''));
		if (ng > 0) process.exitCode = 2;
	} finally {
		closeSync(img.fd);
	}
}

try {
	main(process.argv.slice(2));
} catch (e) {
	console.error(`エラー: ${e.message}`);
	process.exit(1);
}
