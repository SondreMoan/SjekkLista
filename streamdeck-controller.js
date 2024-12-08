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
            { name: 'MIK PGL1', lifetime: 3, lastReset: null },
            { name: 'MIK PGL2', lifetime: 4, lastReset: null },
            { name: 'MIK MET', lifetime: 5, lastReset: null },
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
        this.maxLogs = 300; // Maksimalt antall loggmeldinger vi vil beholde
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
        this.pageBuffers = new Map(); // Cache for side-buffers
        this.isAwake = false; // Ny variabel for å spore vekket tilstand
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
                let color = '#0E927C'; // Standard farge
                let textColor = '#FFFFFF'; // Standard tekstfarge
                
                // Endre farge basert på antall dager igjen
                if (daysLeft <= 0) {
                    color = '#FF7461'; // Rød
                } else if (daysLeft <= 1) {
                    color = '#FFB37A'; // Gul
                    if (isStatus) textColor = '#000000'; // Endre tekstfarge til svart hvis status
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
        console.log('Oppdaterer dynamiske knapper...'); // Legg til logging
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
                
                // Oppdater cachen med nye bilder
                this.pageBuffers.set(displayIndex + 5, statusBuffer);
                this.pageBuffers.set(displayIndex + 10, dateBuffer);
                
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
            
            // Cache side-buffers ved oppstart
            await this.cachePageBuffers();
            
            // Vis første side umiddelbart etter caching
            console.log('Viser første side...');
            await this.switchPage(0);
            
            // Sett opp nattmodus etter at StreamDeck er initialisert
            this.setupNightMode();

            console.log('Initialisering fullført');
            this.addLog('Streamdeck-kontroller startet', 'info');

            // Legg til timer for å oppdatere knappene hvert minutt
            setInterval(() => {
                const now = new Date();
                const currentMinute = now.getMinutes();

                // Sjekk om det er tid for oppdatering
                if (currentMinute === 0 || currentMinute === 30) { // Oppdaterer ved starten av hver hele og halve time
                    this.updateDynamicButtons();
                }
            }, 30000); // 30000 ms = 30 sekund

            


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
                    this.isAwake = false; // Sett isAwake til false når nattmodus aktiveres
                }
            } else {
                this.deck.setBrightness(this.BRIGHTNESS_SETTINGS.DAY_BRIGHTNESS);
                this.isAwake = true; // Sett isAwake til true når dagmodus aktiveres
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
                
                // Vekker systemet hvis det ikke allerede er vekket
                if (!this.isAwake) {
                    this.deck.setBrightness(this.BRIGHTNESS_SETTINGS.DAY_BRIGHTNESS);
                    this.isAwake = true; // Sett til vekket
                    return; // Avslutt her for å unngå å utføre mer
                }
                
                // Hvis systemet allerede er vekket, fortsett med lysstyrkeøkning
                this.deck.setBrightness(this.BRIGHTNESS_SETTINGS.DAY_BRIGHTNESS);
                
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

        // Sjekk om systemet er i nattmodus
        const hour = new Date().getHours();
        const isNightMode = hour >= this.BRIGHTNESS_SETTINGS.NIGHT_MODE_START || 
                            hour < this.BRIGHTNESS_SETTINGS.NIGHT_MODE_END;

        // Håndter nattmodus vekking
        if (isNightMode && !this.isAwake) {
            // Vekker systemet
            this.deck.setBrightness(this.BRIGHTNESS_SETTINGS.DAY_BRIGHTNESS);
            this.addLog('Systemet vekket - lysstyrke satt til 80%', 'info');
            this.isAwake = true; // Sett til vekket
            return; // Avslutt her for å unngå å utføre mer
        }

        // Hvis systemet ikke er vekket, gjør ingenting
        if (!this.isAwake) {
            return; // Ingen handlinger utføres før systemet er vekket
        }

        // Håndter sidenavigasjon
        if (keyIndex === 10) {  // Knapp 11 - Gå tilbake
            if (this.currentPage === 2) {
                this.addLog('Byttet til side 2', 'info');
                await this.switchPage(1);
                return;
            } else if (this.currentPage === 1) {
                this.addLog('Byttet til side 1', 'info');
                await this.switchPage(0);
                return;
            }
        } else if (keyIndex === 14) {  // Knapp 15 - Gå frem
            if (this.currentPage === 0) {
                this.addLog('Byttet til side 2', 'info');
                await this.switchPage(1);
                return;
            } else if (this.currentPage === 1) {
                this.addLog('Byttet til side 3', 'info');
                await this.switchPage(2);
                return;
            }
        }

           if (keyIndex >= 6 && keyIndex <= 10 || keyIndex === 12 || keyIndex === 13) {
            this.addLog(`Knapp ${keyIndex + 1} trykket, men har ingen funksjon.`, 'warning');
            return; // Ingen handlinger utføres for disse knappene
        }

        // Hvis systemet er vekket, fortsett med normal behandling
        if (this.isAwake) {
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
            }
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
            const buffers = new Map();
            
            // Bruk cached statiske bilder
            const cachedPage = this.pageBuffers.get(newPage);
            if (cachedPage) {
                for (const [index, buffer] of cachedPage.entries()) {
                    buffers.set(index, buffer);
                }
            }
            
            // Generer bilder for enheter
            const pageOffset = newPage * 5;
            const startIndex = pageOffset;
            const endIndex = Math.min(startIndex + 5, this.devices.length);
            
            const dynamicPromises = [];
            for (let i = startIndex; i < endIndex; i++) {
                const device = this.devices[i];
                const displayIndex = i - pageOffset;

                // Sjekk om enheten har lifetime 0 og lastReset er null
                if (device.lifetime === 0 && device.lastReset === null) {
                    // Bruk standardbilde for enheter med lifetime 0 og lastReset null
                    dynamicPromises.push(
                        (async () => {
                            const defaultImageBuffer = await sharp('./png/mork-blaa.png')
                                .resize(72, 72)
                                .removeAlpha()
                                .raw()
                                .toBuffer({ resolveWithObject: true });

                            // Opprett en buffer for StreamDeck
                            const streamDeckBuffer = Buffer.alloc(72 * 72 * 3); // 72x72 piksler, 3 bytes per piksel (RGB)

                            // Kopier data fra defaultImageBuffer til streamDeckBuffer
                            for (let i = 0; i < 72 * 72; i++) {
                                const srcPos = i * 3; // Kildeposisjon i defaultImageBuffer
                                const dstPos = i * 3; // Destinasjonsposisjon i streamDeckBuffer

                                // Kopier RGB-data
                                streamDeckBuffer[dstPos] = defaultImageBuffer.data[srcPos];     // R
                                streamDeckBuffer[dstPos + 1] = defaultImageBuffer.data[srcPos + 1]; // G
                                streamDeckBuffer[dstPos + 2] = defaultImageBuffer.data[srcPos + 2]; // B
                            }

                            // Sett bufferet for både status og dato
                            buffers.set(displayIndex + 5, streamDeckBuffer);
                            buffers.set(displayIndex + 10, streamDeckBuffer);
                        })()
                    );
                } else {
                    // Generer status- og databilder for enheter med gyldig informasjon
                    dynamicPromises.push(
                        (async () => {
                            const statusBuffer = await this.generateHTMLImage(device, true);
                            const dateBuffer = await this.generateHTMLImage(device, false);
                            buffers.set(displayIndex + 5, statusBuffer);
                            buffers.set(displayIndex + 10, dateBuffer);
                        })()
                    );
                }
            }
            
            // Vent på at alle dynamiske bilder er generert
            await Promise.all(dynamicPromises);
            
            // Oppdater siden før vi viser knappene
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

    async cachePageBuffers() {
        // Cache buffers for begge sider
        for (let page = 0; page <= 1; page++) {
            const buffers = new Map();
            
            // Cache statiske bilder
            for (let i = 0; i < 5; i++) {
                const imageBuffer = await sharp(this.staticImages[page][i])
                    .resize(72, 72)
                    .removeAlpha()
                    .toBuffer();
                
                const preparedBuffer = await this.prepareImageBuffer(imageBuffer);
                buffers.set(i, preparedBuffer);
            }
            
            this.pageBuffers.set(page, buffers);
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