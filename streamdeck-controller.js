const { openStreamDeck, listStreamDecks } = require('@elgato-stream-deck/node');
const sharp = require('sharp');
const path = require('path');
const express = require('express');
const fs = require('fs').promises;
const moment = require('moment');
const WebSocket = require('ws');
const { chromium } = require('playwright');

class StreamDeckLifecycle {
    constructor() {
        this.deck = null;
        this.BUFFER_SIZE = 15552;
        this.dataPath = path.join(__dirname, 'data.json');
        this.staticImages = {
            0: [
                './png/Knapp-0.png',
                './png/Knapp-1.png',
                './png/Knapp-2.png',
                './png/Knapp-3.png',
                './png/Knapp-4.png'
            ],
            1: [
                './png/mik-pgl1.png',
                './png/mik-pgl2.png',
                './png/mik-met.png',
                './png/mork-blaa.png',
                './png/mork-blaa.png'
            ]
        };
        
        // Standard enhetsdata
        this.defaultDevices = [
            { name: 'Ore PGL1', lifetime: 2, lastReset: null },
            { name: 'Ore PGL2', lifetime: 7, lastReset: null },
            { name: 'Ore Met', lifetime: 4, lastReset: null },
            { name: 'Kam Ref', lifetime: 5, lastReset: null },
            { name: 'Vaer Trykker', lifetime: 3, lastReset: null },
            { name: 'Enhet 6', lifetime: 3, lastReset: null },
            { name: 'Enhet 7', lifetime: 4, lastReset: null },
            { name: 'Enhet 8', lifetime: 5, lastReset: null },
            { name: 'Enhet 9', lifetime: 2, lastReset: null },
            { name: 'Enhet 10', lifetime: 6, lastReset: null }
        ];
        
        this.devices = [];
        this.setupWebServer();
        process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD = true;
        this.puppeteerInstance = null;  // Lagre én Puppeteer-instans
        this.imageCache = new Map();    // Cache for genererte bilder
        this.pauseImage = './png/nrk.png';  // Legg til denne linjen
        this.setupShutdownHandler();  // Legg til denne linjen
        this.processingButtons = new Set();
        this.setupErrorHandlers();
        this.logs = [];
        this.maxLogs = 100; // Maksimalt antall loggmeldinger vi vil beholde
        this.logFilePath = path.join(__dirname, 'logs.json');
        this.brightnessTimeout = null;  // Legg til denne linjen
        this.browser = null;
        this.context = null;
        this.page = null;
        this.webServer = null;
        
        // Lysstyrke-innstillinger
        this.BRIGHTNESS_SETTINGS = {
            NIGHT_MODE_START: 20,    // Starter kl 20:00
            NIGHT_MODE_END: 5,       // Slutter kl 05:00
            DAY_BRIGHTNESS: 80,      // 80% lysstyrke på dagen
            NIGHT_BRIGHTNESS: 0,     // 0% lysstyrke på natten
            TEMP_BOOST_DURATION: 30000 // 30 sekunder midlertidig boost
        };
        
        // Last eksisterende logger ved oppstart
        this.loadLogs().then(() => {
            // Legg til WebSocket-server
            this.wss = new WebSocket.Server({ port: 3001 });
            
            this.wss.on('connection', (ws) => {
                console.log('Ny WebSocket-klient tilkoblet');
                ws.send(JSON.stringify({
                    type: 'logs',
                    data: this.logs
                }));
            });

            // Legg til oppstartslogg
            this.addLog('Streamdeck-kontroller startet', 'info');
        });
        
        // Legg til kø-system
        this.buttonQueue = [];
        this.isProcessingQueue = false;
        this.activeProcesses = new Set();
        this.currentPage = 0;  // Legg til sidesporing
    }

    async loadData() {
        try {
            const data = await fs.readFile(this.dataPath, 'utf8');
            this.devices = JSON.parse(data);
        } catch (error) {
            console.log('Ingen eksisterende data funnet, bruker standardverdier');
            this.devices = this.defaultDevices;
            await this.saveData();
        }
    }

    async saveData() {
        await fs.writeFile(this.dataPath, JSON.stringify(this.devices, null, 2));
    }

    setupWebServer() {
        const app = express();
        app.use(express.json());
        app.use(express.static('public'));

        app.get('/devices', (req, res) => {
            res.json(this.devices);
        });

        app.post('/devices/:id', async (req, res) => {
            const { id } = req.params;
            const { lifetime } = req.body;
            
            if (id >= 0 && id < this.devices.length) {
                this.devices[id].lifetime = lifetime;
                await this.saveData();
                await this.updateDynamicButtons();
                res.json({ success: true });
            } else {
                res.status(400).json({ error: 'Ugyldig enhets-ID' });
            }
        });

        app.listen(3000, '0.0.0.0', () => {
            console.log('Web server kjører på http://0.0.0.0:3000');
        });
    }

    async generateHTMLImage(device, isStatus) {
        try {
            await this.ensureBrowser();
            const page = await this.context.newPage();
            
            try {
                await page.setViewportSize({ width: 72, height: 72 });
                
                const daysLeft = this.calculateDaysLeft(device);
                const percentage = (daysLeft / device.lifetime) * 100;
                
                let color = '#0E927C';
                let textColor = '#FFFFFF';
                
                if (percentage <= 20) {
                    color = '#FF7461';
                } else if (percentage < 40) {
                    color = '#FFB37A';
                    if (isStatus) textColor = '#000000';
                }
                
                const html = `
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <style>
                            * { margin: 0; padding: 0; box-sizing: border-box; }
                            body {
                                width: 72px;
                                height: 72px;
                                background: ${isStatus ? color : '#0A2343'};
                                display: flex;
                                justify-content: center;
                                align-items: center;
                                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen-Sans, Ubuntu, Cantarell, "Helvetica Neue", sans-serif;
                                color: ${isStatus ? textColor : '#FFFFFF'};
                                text-align: center;
                            }
                            .container {
                                display: flex;
                                flex-direction: column;
                                align-items: center;
                                justify-content: center;
                            }
                            .value {
                                font-size: ${isStatus ? '28px' : '25px'};
                                font-weight: bold;
                                line-height: 1;
                            }
                            .subtext {
                                font-size: 16px;
                                margin-top: 2px;
                            }
                        </style>
                    </head>
                    <body>
                        <div class="container">
                            ${isStatus ? `
                                <div class="value">${Math.ceil(daysLeft)}</div>
                                <div class="subtext">${Math.ceil(daysLeft) === 1 ? 'dag' : 'dager'}</div>
                            ` : `
                                <div class="value">${device.lastReset ? moment(device.lastReset).format('DD.MM<br>HH:mm') : '-'}</div>
                            `}
                        </div>
                    </body>
                    </html>
                `;
                
                await page.setContent(html);
                await page.waitForLoadState('domcontentloaded');
                
                const screenshotBuffer = await page.screenshot({
                    type: 'png'
                });
                
                const processedBuffer = await sharp(screenshotBuffer)
                    .resize(72, 72)
                    .removeAlpha()
                    .raw()
                    .toBuffer({ resolveWithObject: true });
                
                const streamDeckBuffer = Buffer.alloc(72 * 72 * 3);
                
                for (let i = 0; i < 72 * 72; i++) {
                    const srcPos = i * 3;
                    const dstPos = i * 3;
                    streamDeckBuffer[dstPos] = processedBuffer.data[srcPos];
                    streamDeckBuffer[dstPos + 1] = processedBuffer.data[srcPos + 1];
                    streamDeckBuffer[dstPos + 2] = processedBuffer.data[srcPos + 2];
                }
                
                return streamDeckBuffer;
                
            } finally {
                await page.close().catch(console.error);
            }
            
        } catch (error) {
            console.error(`Feil ved generering av ${isStatus ? 'status' : 'dato'} bilde:`, error);
            throw error;
        }
    }

    getColorForDaysLeft(daysLeft) {
        if (daysLeft <= 0) return '#ff0000';  // Rød
        if (daysLeft <= 1) return '#ffa500';  // Oransje
        if (daysLeft <= 2) return '#ffff00';  // Gul
        return '#00ff00';  // Grønn
    }

    formatDate(dateString) {
        const date = new Date(dateString);
        return `${date.getDate().toString().padStart(2, '0')}.${(date.getMonth() + 1).toString().padStart(2, '0')}`;
    }

    calculateDaysLeft(device) {
        if (!device.lastReset) return device.lifetime;
        const now = moment();
        const reset = moment(device.lastReset);
        const daysPassed = now.diff(reset, 'days', true);
        return Math.max(0, device.lifetime - daysPassed);
    }

    async prepareImageBuffer(buffer) {
        return await sharp(buffer)
            .resize(72, 72)
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true })
            .then(({ data, info }) => {
                const streamDeckBuffer = Buffer.alloc(72 * 72 * 3);
                
                for (let i = 0; i < 72 * 72; i++) {
                    const srcPos = i * 3;
                    const dstPos = i * 3;
                    
                    // RGB til BGR konvertering
                    const r = data[srcPos];
                    const g = data[srcPos + 1];
                    const b = data[srcPos + 2];
                    
                    streamDeckBuffer[dstPos] = r;     // R
                    streamDeckBuffer[dstPos + 1] = g; // G
                    streamDeckBuffer[dstPos + 2] = b; // B
                }
                
                return streamDeckBuffer;
            });
    }

    async updateDynamicButtons(deviceIndex = null) {
        try {
            await this.ensureBrowser();
            
            const pageOffset = this.currentPage * 5;
            const startIndex = pageOffset;
            const endIndex = startIndex + 5;
            
            if (deviceIndex !== null) {
                // Hvis deviceIndex er utenfor gjeldende side, ikke gjør noe
                if (deviceIndex < startIndex || deviceIndex >= endIndex) return;
                
                const device = this.devices[deviceIndex];
                const displayIndex = deviceIndex - pageOffset;
                const statusBuffer = await this.generateHTMLImage(device, true);
                const dateBuffer = await this.generateHTMLImage(device, false);
                
                await this.deck.fillKeyBuffer(displayIndex + 5, statusBuffer);
                await this.deck.fillKeyBuffer(displayIndex + 10, dateBuffer);
                return;
            }
            
            // Oppdater alle knapper for gjeldende side
            for (let i = startIndex; i < endIndex; i++) {
                const device = this.devices[i];
                const displayIndex = i - pageOffset;
                const statusBuffer = await this.generateHTMLImage(device, true);
                const dateBuffer = await this.generateHTMLImage(device, false);
                
                await this.deck.fillKeyBuffer(displayIndex + 5, statusBuffer);
                await this.deck.fillKeyBuffer(displayIndex + 10, dateBuffer);
            }
            
        } catch (error) {
            console.error('Feil ved oppdatering av dynamiske knapper:', error);
            throw error;
        }
    }

    async initialize() {
        try {
            console.log('Starter initialisering...');
            
            // Initialiser Playwright først
            console.log('Starter browser...');
            this.browser = await chromium.launch({
                headless: true
            });
            
            console.log('Oppretter browser context...');
            this.context = await this.browser.newContext({
                viewport: { width: 72, height: 72 }
            });
            
            console.log('Oppretter ny side...');
            this.page = await this.context.newPage();
            
            // Vent på at siden er klar
            await this.page.waitForLoadState('domcontentloaded');
            
            console.log('Browser er klar');

            // Last data
            console.log('Laster data...');
            const rawData = await fs.readFile(path.join(__dirname, 'data.json'), 'utf8');
            this.devices = JSON.parse(rawData);

            // Initialiser StreamDeck
            console.log('Kobler til StreamDeck...');
            await this.openStreamDeck();
            
            // Flytt setupNightMode() hit, etter at StreamDeck er initialisert
            this.setupNightMode();
            
            // Webserver er allerede satt opp i konstruktøren via setupWebServer()
            console.log('Webserver er allerede startet...');

            // Last statiske bilder for gjeldende side
            for (let i = 0; i < 5; i++) {
                try {
                    const imageBuffer = await sharp(this.staticImages[this.currentPage][i])
                        .resize(72, 72)
                        .removeAlpha()
                        .toBuffer();
                    
                    const preparedBuffer = await this.prepareImageBuffer(imageBuffer);
                    await this.deck.fillKeyBuffer(i, preparedBuffer);
                } catch (error) {
                    console.error(`Feil ved lasting av statisk bilde ${i + 1}:`, error);
                    throw error;
                }
            }

            // Oppdater knapper kun for gjeldende side
            console.log('Oppdaterer knapper...');
            const pageOffset = this.currentPage * 5;
            const startIndex = pageOffset;
            const endIndex = Math.min(startIndex + 5, this.devices.length);

            for (let i = startIndex; i < endIndex; i++) {
                const device = this.devices[i];
                const displayIndex = i - pageOffset;
                console.log(`Genererer bilde for ${device.name}...`);
                
                try {
                    const statusBuffer = await this.generateHTMLImage(device, true);
                    const dateBuffer = await this.generateHTMLImage(device, false);
                    
                    await this.deck.fillKeyBuffer(displayIndex + 5, statusBuffer);
                    await this.deck.fillKeyBuffer(displayIndex + 10, dateBuffer);
                } catch (error) {
                    console.error(`Feil ved generering av bilder for ${device.name}:`, error);
                }
            }

            console.log('Initialisering fullført');
            this.addLog('Streamdeck-kontroller startet', 'info');

        } catch (error) {
            console.error('Initialiseringsfeil:', error);
            
            // Cleanup ved feil
            if (this.page) await this.page.close().catch(console.error);
            if (this.context) await this.context.close().catch(console.error);
            if (this.browser) await this.browser.close().catch(console.error);
            
            throw error;
        }
    }

    async cleanup() {
        if (this.page) await this.page.close();
        if (this.context) await this.context.close();
        if (this.browser) await this.browser.close();
        // ... resten av cleanup koden ...
    }

    setupShutdownHandler() {
        let isShuttingDown = false;

        const cleanup = async () => {
            if (isShuttingDown) return;
            isShuttingDown = true;

            console.log('Starter shutdown-sekvens...');
            
            // Hold prosessen aktiv
            const keepAlive = setInterval(() => {}, 100);
            
            if (this.deck) {
                try {
                    console.log('Tømmer panel...');
                    await this.deck.resetToLogo();
                    
                    console.log('Venter på at panel tømmes fullstendig...');
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    
                    console.log('Panel tømt');
                } catch (error) {
                    console.error('Feil under shutdown:', error);
                }
            }

            await new Promise(resolve => setTimeout(resolve, 1000));
            
            clearInterval(keepAlive);
            console.log('Avslutter prosess...');
            process.exit(0);
        };

        const shutdownHandler = async (signal) => {
            console.log(`Mottok ${signal} signal`);
            try {
                await cleanup();
            } catch (error) {
                console.error('Feil i shutdown handler:', error);
                process.exit(1);
            }
        };

        // Legg til handlers for alle relevante signaler
        process.on('SIGINT', () => shutdownHandler('SIGINT'));     // Ctrl+C
        process.on('SIGTERM', () => shutdownHandler('SIGTERM'));   // kill command
        process.on('SIGHUP', () => shutdownHandler('SIGHUP'));     // Terminal lukkes
        process.on('exit', () => shutdownHandler('exit'));         // process.exit()
        
        // Håndter ukontrollerte feil
        process.on('uncaughtException', async (error) => {
            console.error('Ukontrollert feil:', error);
            await shutdownHandler('uncaughtException');
        });
        
        // Håndter ubehandlede Promise-rejections
        process.on('unhandledRejection', async (reason, promise) => {
            console.error('Ubehandlet Promise rejection:', reason);
            await shutdownHandler('unhandledRejection');
        });
    }

    async showCelebrationEmoji(keyIndex) {
        try {
            const animationKey = `animation_${keyIndex}`;
            
            if (this[animationKey]) {
                clearTimeout(this[animationKey]);
            }
            
            // Last alle frames på forhånd
            const frames = [
                './assets/hug-emoji_1.png',
                './assets/hug-emoji_2.png',
                './assets/hug-emoji_3.png',
                './assets/hug-emoji_4.png',
                './assets/hug-emoji_5.png',
                './assets/hug-emoji_6.png',
                './assets/hug-emoji_7.png',
                './assets/hug-emoji_8.png',
                './assets/hug-emoji_9.png',
                './assets/hug-emoji_10.png',
                './assets/hug-emoji_11.png',
                './assets/hug-emoji_12.png',
                './assets/hug-emoji_13.png'
            ];
            
            const preparedFrames = await Promise.all(
                frames.map(frame => 
                    sharp(frame)
                        .resize(72, 72)
                        .removeAlpha()
                        .toBuffer()
                        .then(buffer => this.prepareImageBuffer(buffer))
                )
            );
            
            // Kjør animasjonen
            for (const frame of preparedFrames) {
                await this.deck.fillKeyBuffer(keyIndex, frame);
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            
        } catch (error) {
            console.error('Feil ved visning av animasjon:', error);
        }
    }

    setupErrorHandlers() {
        // Håndter ukontrollerte Promise-feil
        process.on('unhandledRejection', async (error) => {
            console.error('Ukontrollert Promise-feil:', error);
            await this.showErrorState();
        });

        // Håndter generelle crashes
        process.on('uncaughtException', async (error) => {
            console.error('Kritisk feil i applikasjonen:', error);
            await this.showErrorState();
            // Gi tid til å vise feilmeldingen før shutdown
            setTimeout(() => process.exit(1), 1000);
        });
    }

    async showErrorState() {
        try {
            console.log('Starter clearing av panel...');
            await this.deck.clearPanel();
            console.log('Panel cleared successfully');
        } catch (error) {
            console.error('Feil ved clearing av panel:', error);
        }
    }

    async loadLogs() {  
        try {
            const data = await fs.readFile(this.logFilePath, 'utf8');
            this.logs = JSON.parse(data);
            console.log(`Lastet ${this.logs.length} logger fra fil`);
        } catch (error) {
            console.log('Ingen eksisterende loggfil funnet, starter med tom logg');
            this.logs = [];
        }
    }

    async addLog(message, type = 'info') {
        const logEntry = {
            timestamp: new Date().toISOString(),
            message,
            type // 'info', 'warning', eller 'error'
        };
        
        // Legg til ny logg først i arrayet
        this.logs.unshift(logEntry);
        
        // Behold bare de siste 100 loggene
        if (this.logs.length > this.maxLogs) {
            this.logs = this.logs.slice(0, this.maxLogs);
        }
        
        // Lagre logger til fil
        try {
            await fs.writeFile(this.logFilePath, JSON.stringify(this.logs, null, 2));
        } catch (error) {
            console.error('Feil ved lagring av logger:', error);
        }
        
        // Send oppdatert logg til alle tilkoblede websocket-klienter
        this.wss?.clients?.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                    type: 'logs',
                    data: this.logs
                }));
            }
        });
    }

    setupNightMode() {
        // Sett initial lysstyrke
        this.updateBrightness();
        
        // Sjekk lysstyrke hvert minutt
        setInterval(() => {
            this.updateBrightness();
        }, 60000);

        this.addLog('Nattmodus-funksjonalitet aktivert', 'info');
    }

    updateBrightness() {
        const hour = new Date().getHours();
        console.log(`Sjekker lysstyrke. Klokken er ${hour}`);
        console.log('StreamDeck tilgjengelig:', !!this.deck);
        
        try {
            if (hour >= this.BRIGHTNESS_SETTINGS.NIGHT_MODE_START || 
                hour < this.BRIGHTNESS_SETTINGS.NIGHT_MODE_END) {
                if (!this.brightnessTimeout) {
                    this.deck.setBrightness(this.BRIGHTNESS_SETTINGS.NIGHT_BRIGHTNESS);
                    this.addLog('Nattmodus aktivert - lysstyrke satt til 0%', 'info');
                }
            } else {
                this.deck.setBrightness(this.BRIGHTNESS_SETTINGS.DAY_BRIGHTNESS);
                this.addLog('Dagmodus aktivert - lysstyrke satt til 80%', 'info');
            }
        } catch (error) {
            console.error('Feil ved oppdatering av lysstyrke:', error);
            this.addLog('Feil ved oppdatering av lysstyrke: ' + error.message, 'error');
        }
    }

    temporaryBrightnessBoost() {
        try {
            const hour = new Date().getHours();
            const isNightMode = hour >= this.BRIGHTNESS_SETTINGS.NIGHT_MODE_START || 
                               hour < this.BRIGHTNESS_SETTINGS.NIGHT_MODE_END;

            if (isNightMode) {
                if (this.brightnessTimeout) {
                    clearTimeout(this.brightnessTimeout);
                }
                
                this.deck.setBrightness(this.BRIGHTNESS_SETTINGS.DAY_BRIGHTNESS);
                this.addLog('Midlertidig økning av lysstyrke til 80%', 'info');
                
                this.brightnessTimeout = setTimeout(() => {
                    if (hour >= this.BRIGHTNESS_SETTINGS.NIGHT_MODE_START || 
                        hour < this.BRIGHTNESS_SETTINGS.NIGHT_MODE_END) {
                        this.deck.setBrightness(this.BRIGHTNESS_SETTINGS.NIGHT_BRIGHTNESS);
                        this.addLog('Nattmodus gjenopptatt - lysstyrke tilbake til 0%', 'info');
                    }
                    this.brightnessTimeout = null;
                }, this.BRIGHTNESS_SETTINGS.TEMP_BOOST_DURATION);
            }
        } catch (error) {
            this.addLog('Feil ved midlertidig lysøkning: ' + error.message, 'error');
        }
    }

    async handleKeyPress(keyData) {
        const keyIndex = keyData.index;
        this.temporaryBrightnessBoost();

        // Håndter sidenavigasjon
        if (keyIndex === 10) {  // Knapp 11 - Gå tilbake
            if (this.currentPage === 1) {
                this.addLog('Byttet til side 1', 'info');
                await this.switchPage(0);
                return;
            }
        } else if (keyIndex === 14) {  // Knapp 15 - Gå frem
            if (this.currentPage === 0) {
                this.addLog('Byttet til side 2', 'info');
                await this.switchPage(1);
                return;
            }
        }

        // Modifiser indeksene basert på gjeldende side
        const pageOffset = this.currentPage * 5;
        
        if (keyIndex >= 0 && keyIndex < 5) {
            const deviceIndex = keyIndex + pageOffset;
            const device = this.devices[deviceIndex];
            
            if (this.activeProcesses.has(deviceIndex)) {
                this.addLog(`Hopper over "${device.name}" - allerede under prosessering`, 'warning');
                return;
            }
            
            this.activeProcesses.add(deviceIndex);
            this.addLog(`Starter nullstilling av "${device.name}"`, 'info');
            
            try {
                // Oppdater data først
                this.devices[deviceIndex].lastReset = new Date().toISOString();
                await this.saveData();
                
                // Vis emoji-animasjon på riktig knapp (justert for side)
                await this.showCelebrationEmoji(keyIndex + 5);
                
                // Generer og oppdater knappene med riktig sideoffset
                const statusBuffer = await this.generateHTMLImage(device, true);
                const dateBuffer = await this.generateHTMLImage(device, false);
                
                // Bruk keyIndex (ikke deviceIndex) for å oppdatere riktig knapp
                await this.deck.fillKeyBuffer(keyIndex + 5, statusBuffer);
                await this.deck.fillKeyBuffer(keyIndex + 10, dateBuffer);
                
                this.addLog(`Vellykket nullstilling av "${device.name}"`, 'info');
                
            } catch (error) {
                this.addLog(`Feil ved nullstilling av "${device.name}": ${error.message}`, 'error');
            } finally {
                this.activeProcesses.delete(deviceIndex);
            }
        } else if (keyIndex >= 5 && keyIndex < 15 && keyIndex !== 10 && keyIndex !== 14) {
            // Logger for knapper som bare er for visning
            this.addLog(`Knapp ${keyIndex + 1} er bare for visning`, 'info');
        }
    }

    // Ny metode for å prosessere køen
    async processButtonQueue() {
        if (this.isProcessingQueue) return;
        this.isProcessingQueue = true;
        
        while (this.buttonQueue.length > 0) {
            const { keyIndex, deviceIndex, device } = this.buttonQueue.shift();
            
            try {
                console.log(`Prosesserer kø: Knapp ${keyIndex + 1} for ${device.name}`);
                
                // Oppdater data
                this.devices[deviceIndex].lastReset = new Date().toISOString();
                await this.saveData();
                
                // Vis animasjon og vent til den er ferdig
                await this.showCelebrationEmoji(keyIndex + 5);
                
                // Oppdater kun knappene for denne enheten
                const statusBuffer = await this.generateHTMLImage(device, true);
                const dateBuffer = await this.generateHTMLImage(device, false);
                
                await this.deck.fillKeyBuffer(deviceIndex + 5, statusBuffer);
                await this.deck.fillKeyBuffer(deviceIndex + 10, dateBuffer);
                
                this.addLog(`Vellykket nullstilling av "${device.name}"`, 'info');
                
            } catch (error) {
                this.addLog(`Feil ved nullstilling av "${device.name}": ${error.message}`, 'error');
            }
            
            // Vent litt mellom hver prosessering
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        this.isProcessingQueue = false;
    }

    // Legg til en metode for å håndtere feil og gjenopprette browser om nødvendig
    async ensureBrowser() {
        try {
            if (!this.browser || !this.page) {
                console.log('Gjenoppretter browser-sesjon...');
                
                if (this.page) await this.page.close().catch(console.error);
                if (this.context) await this.context.close().catch(console.error);
                if (this.browser) await this.browser.close().catch(console.error);
                
                this.browser = await chromium.launch({ headless: true });
                this.context = await this.browser.newContext({
                    viewport: { width: 72, height: 72 }
                });
                this.page = await this.context.newPage();
                await this.page.waitForLoadState('domcontentloaded');
            }
        } catch (error) {
            console.error('Feil ved gjenoppretting av browser:', error);
            throw error;
        }
    }

    async openStreamDeck() {
        try {
            console.log('Leter etter StreamDeck enheter...');
            const devices = await listStreamDecks();
            
            if (devices.length === 0) {
                throw new Error('Ingen StreamDeck enheter funnet');
            }

            console.log('Fant StreamDeck enheter:', devices);
            const device = devices[0]; // Bruk første tilgjengelige enhet
            
            console.log('Kobler til StreamDeck:', device.path);
            this.deck = await openStreamDeck(device.path);
            await this.deck.clearPanel();

            if (!this.deck) {
                throw new Error('Kunne ikke åpne StreamDeck');
            }

            console.log('StreamDeck tilkoblet');

            // Sett opp event listeners
            this.deck.on('down', keyData => this.handleKeyPress(keyData));
            this.deck.on('error', error => {
                console.error('StreamDeck feil:', error);
                this.addLog('StreamDeck feil: ' + error.message, 'error');
            });

            // Sett lysstyrke
            await this.deck.setBrightness(80);
            
            return true;
        } catch (error) {
            console.error('Feil ved tilkobling til StreamDeck:', error);
            this.addLog('Kunne ikke koble til StreamDeck: ' + error.message, 'error');
            throw error;
        }
    }

    // Legg til metode for å bytte side
    async switchPage(newPage) {
        if (newPage < 0 || newPage > 1) return;
        
        try {
            // Forbered alle buffers for den nye siden
            const buffers = new Map();
            
            // Last statiske bilder
            for (let i = 0; i < 5; i++) {
                const imageBuffer = await sharp(this.staticImages[newPage][i])
                    .resize(72, 72)
                    .removeAlpha()
                    .toBuffer();
                
                const preparedBuffer = await this.prepareImageBuffer(imageBuffer);
                buffers.set(i, preparedBuffer);
            }
            
            // Forbered dynamiske bilder
            const pageOffset = newPage * 5;
            const startIndex = pageOffset;
            const endIndex = Math.min(startIndex + 5, this.devices.length);
            
            for (let i = startIndex; i < endIndex; i++) {
                const device = this.devices[i];
                const displayIndex = i - pageOffset;
                
                const statusBuffer = await this.generateHTMLImage(device, true);
                const dateBuffer = await this.generateHTMLImage(device, false);
                
                buffers.set(displayIndex + 5, statusBuffer);
                buffers.set(displayIndex + 10, dateBuffer);
            }
            
            // Oppdater currentPage før vi viser knappene
            this.currentPage = newPage;
            
            // Vis alle knapper samtidig
            const updatePromises = [];
            for (const [index, buffer] of buffers.entries()) {
                updatePromises.push(this.deck.fillKeyBuffer(index, buffer));
            }
            
            await Promise.all(updatePromises);
            
        } catch (error) {
            console.error('Feil ved bytte av side:', error);
            this.addLog('Feil ved sidebytte: ' + error.message, 'error');
        }
    }

    // Legg til denne nye metoden
    async updateAllButtons() {
        try {
            // Oppdater statiske bilder for gjeldende side
            for (let i = 0; i < 5; i++) {
                try {
                    const imageBuffer = await sharp(this.staticImages[this.currentPage][i])
                        .resize(72, 72)
                        .removeAlpha()
                        .toBuffer();
                    
                    const preparedBuffer = await this.prepareImageBuffer(imageBuffer);
                    await this.deck.fillKeyBuffer(i, preparedBuffer);
                } catch (error) {
                    console.error(`Feil ved lasting av statisk bilde ${i + 1}:`, error);
                }
            }

            // Oppdater dynamiske knapper for gjeldende side
            await this.updateDynamicButtons();
        } catch (error) {
            console.error('Feil ved oppdatering av alle knapper:', error);
            throw error;
        }
    }
}

// Start applikasjonen
async function main() {
    try {
        const controller = new StreamDeckLifecycle();
        await controller.initialize();
    } catch (error) {
        console.error('Applikasjonsfeil:', error);
        process.exit(1);
    }
}

main();