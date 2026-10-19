// Symlink the host pi's packages into node_modules so tests and tsc resolve
// @earendil-works/* and @types/node without installing anything.
// Local pi packages must NOT ship node_modules; this is dev-only.
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execSync } from "node:child_process";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");

async function findPiModules() {
	try {
		const bin = execSync("command -v pi", { encoding: "utf8" }).trim();
		const real = execSync(`readlink -f "${bin}" 2>/dev/null || realpath "${bin}"`, { encoding: "utf8" }).trim();
		let dir = dirname(real);
		for (let i = 0; i < 8; i++) {
			const candidate = join(dir, "node_modules");
			if (existsSync(join(candidate, "@earendil-works", "pi-coding-agent"))) return candidate;
			dir = dirname(dir);
		}
	} catch {}
	const home = process.env.HOME ?? "";
	const releases = join(home, ".pi", "agent", "install", "releases");
	if (existsSync(releases)) {
		const versions = readdirSync(releases).sort().reverse();
		for (const v of versions) {
			const candidate = join(releases, v, "node_modules");
			if (existsSync(join(candidate, "@earendil-works", "pi-coding-agent"))) return candidate;
		}
	}
	return undefined;
}

const piModules = await findPiModules();
if (!piModules) {
	console.error("link-pi: could not find an installed pi (npm i -g @earendil-works/pi-coding-agent)");
	process.exit(1);
}

const links = [
	["@earendil-works/pi-coding-agent", "@earendil-works/pi-coding-agent"],
	["@earendil-works/pi-tui", "@earendil-works/pi-tui"],
	["@earendil-works/pi-ai", "@earendil-works/pi-ai"],
	["@types/node", "@types/node"],
];
for (const [name, target] of links) {
	const src = join(piModules, target);
	if (!existsSync(src)) continue;
	const dest = join(root, "node_modules", name);
	mkdirSync(dirname(dest), { recursive: true });
	rmSync(dest, { recursive: true, force: true });
	symlinkSync(src, dest, "dir");
}
console.log(`link-pi: linked pi modules from ${piModules}`);
