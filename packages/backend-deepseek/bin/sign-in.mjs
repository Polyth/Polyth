#!/usr/bin/env node
// Save a DeepSeek API key where DeepSeek Harness reads it, without echoing it.
//
// `dsh` has no login command: its official route reads `DEEPSEEK_API_KEY` from
// the launch environment, then its credential store, then `.env` files. This
// helper writes the key to `$DSH_HOME/.env` (default `~/.dsh/.env`) with mode
// 0600, after checking it against DeepSeek's free balance endpoint. It never
// prints the key. Polyth shows this command as the DeepSeek sign-in step; it
// runs in the user's terminal, never in a chat or an agent tool call.
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const home = process.env.DSH_HOME?.trim() ? resolve(process.env.DSH_HOME.trim()) : join(homedir(), ".dsh");
const envFile = join(home, ".env");
const KEY = /^[A-Za-z0-9._~+/=-]{8,512}$/;
const LINE = /^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=/;

const say = (text) => process.stderr.write(`${text}\n`);

function readHidden(prompt) {
    return new Promise((resolvePromise, reject) => {
        const input = process.stdin;
        if (!input.isTTY) {
            // Non-interactive: the first line of stdin.
            let data = "";
            input.setEncoding("utf8");
            input.on("data", (chunk) => { data += chunk; });
            input.on("end", () => resolvePromise(data.split(/\r?\n/)[0] ?? ""));
            input.on("error", reject);
            return;
        }
        process.stderr.write(prompt);
        let value = "";
        input.setRawMode(true);
        input.setEncoding("utf8");
        input.resume();
        const done = (result, error) => {
            input.setRawMode(false);
            input.pause();
            input.removeListener("data", onData);
            process.stderr.write("\n");
            if (error) reject(error); else resolvePromise(result);
        };
        const onData = (chunk) => {
            for (const char of chunk) {
                if (char === "\r" || char === "\n") return done(value);
                if (char === "\u0003") return done("", Object.assign(new Error("cancelled"), { code: "cancelled" }));
                if (char === "\u007f" || char === "\b") { value = value.slice(0, -1); continue; }
                if (char >= " ") value += char;
            }
        };
        input.on("data", onData);
    });
}

/** `GET /user/balance` is DeepSeek's account endpoint: no model turn, no cost.
 *  A custom `DEEPSEEK_BASE_URL` gateway is not that account, so it is skipped. */
async function check(key) {
    if (process.env.DEEPSEEK_BASE_URL?.trim()) return "unverified";
    try {
        const response = await fetch("https://api.deepseek.com/user/balance", {
            headers: { authorization: `Bearer ${key}`, accept: "application/json" },
            signal: AbortSignal.timeout(10_000),
            redirect: "error",
        });
        if (response.status === 401 || response.status === 403) return "rejected";
        return response.ok ? "verified" : "unverified";
    } catch {
        return "unverified";
    }
}

async function main() {
    say("DeepSeek sign-in for DeepSeek Harness (dsh).");
    say("Create an API key at https://platform.deepseek.com/api_keys");
    if (process.env.DEEPSEEK_API_KEY?.trim()) {
        say("Note: DEEPSEEK_API_KEY is already set in this environment; while it is set it wins over the saved key.");
    }
    const key = (await readHidden("API key (input hidden): ")).trim();
    if (!key) { say("No key entered; nothing saved."); return 1; }
    if (!KEY.test(key)) { say("That does not look like a DeepSeek API key; nothing saved."); return 1; }
    const verdict = await check(key);
    if (verdict === "rejected") { say("DeepSeek rejected this key; nothing saved."); return 1; }
    await mkdir(home, { recursive: true, mode: 0o700 });
    const existing = await readFile(envFile, "utf8").catch((error) => {
        if (error?.code === "ENOENT") return "";
        throw error;
    });
    const kept = existing.split(/\r?\n/).filter((line) => line !== "" && !LINE.test(line));
    const temporary = `${envFile}.${process.pid}.tmp`;
    await writeFile(temporary, `${[...kept, `DEEPSEEK_API_KEY=${key}`].join("\n")}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, envFile);
    say(verdict === "verified"
        ? `Key verified and saved to ${envFile}.`
        : `Saved to ${envFile}. DeepSeek could not be reached to verify it; the first turn will.`);
    say("A key saved in the DeepSeek Harness web Models page takes precedence over this file.");
    return 0;
}

main().then((code) => { process.exitCode = code; }, (error) => {
    say(error?.code === "cancelled" ? "Cancelled; nothing saved." : `Could not save the key: ${error?.message ?? error}`);
    process.exitCode = 1;
});
