import puppeteer from 'puppeteer-core';
import { execSync } from 'child_process';

// Find Chrome/Edge path on Windows
let executablePath;
try {
    executablePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
} catch (e) {
    console.error("Chrome not found");
    process.exit(1);
}

(async () => {
    const browser = await puppeteer.launch({ executablePath, headless: "new" });
    const page = await browser.newPage();
    
    // Capture globals before loading the script
    await page.goto('about:blank');
    const globalsBefore = await page.evaluate(() => Object.getOwnPropertyNames(window));
    
    // Load the stake page
    await page.goto('https://soltao.xyz/stake/');
    const globalsAfter = await page.evaluate(() => Object.getOwnPropertyNames(window));
    
    // Find additions
    const additions = globalsAfter.filter(g => !globalsBefore.includes(g));
    
    // Filter out typical puppeteer/browser extension noise if any
    const pureAdditions = additions.filter(g => !g.startsWith('__'));
    
    console.log("=== Globals added by stake.js ===");
    console.log(pureAdditions);
    
    // Check prototypes
    const protoChecks = await page.evaluate(() => {
        return {
            uint8ArrayIndexOf: !!Uint8Array.prototype.indexOf,
            uint8ArraySliceOverride: Uint8Array.prototype.slice.toString().includes('[native code]') ? 'native' : 'overridden',
            objectPrototypeKeys: Object.keys(Object.prototype),
            bufferExists: typeof Buffer !== 'undefined',
            processExists: typeof process !== 'undefined'
        };
    });
    console.log("\n=== Prototype/Global States ===");
    console.log(protoChecks);
    
    await browser.close();
})();
