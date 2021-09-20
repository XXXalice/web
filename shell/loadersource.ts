// Copyright (c) 2019 Kichikuou <KichikuouChrome@gmail.com>
// This source code is governed by the MIT License, see the LICENSE file.
import {$, startMeasure, mkdirIfNotExist, readFileAsArrayBuffer, loadScript, isMobileSafari, JSZIP_SCRIPT, JSZipOptions} from './util.js';
import * as cdimage from './cdimage.js';
import {CDDACache, BasicCDDACache, IOSCDDACache} from './cddacache.js';
import {registerDataFile} from './datafile.js';
import {loadModule, saveDirReady} from './moduleloader.js';
import {message} from './strings.js';

export class NoGamedataError implements Error {
    public name = 'NoGamedataError';
    constructor(public message: string) {}

    toString() {
        return this.name + ': ' + this.message;
    }
}

export abstract class LoaderSource {
    abstract getCDDA(track: number): Promise<string>;
    protected abstract doLoad(): Promise<void>;

    public hasMidi = false;
    private aldFiles: string[] | null = null;

    async startLoad() {
        await this.doLoad();
        this.createGr();
    }

    protected async loadSystem3(savedir: string) {
        await loadModule('system3');
        Module.arguments.push('-savedir', savedir);
        saveDirReady.then(() => { mkdirIfNotExist(savedir.replace(/\/@$/, '')); });
    }

    protected async loadXsystem35() {
        await loadModule('xsystem35');
        this.aldFiles = [];
    }

    protected addFile(fname: string, size: number, chunks: Uint8Array[]) {
        registerDataFile(fname, size, chunks);
        this.aldFiles?.push(fname);
    }

    private createGr() {
        if (!this.aldFiles) {
            return;
        }
        const resourceType: { [ch: string]: string } = {
            d: 'Data', g: 'Graphics', m: 'Midi', r: 'Resource', s: 'Scenario', w: 'Wave',
        };
        let basename = '';
        let lines: string[] = [];
        for (let name of this.aldFiles) {
            if (name.toLowerCase() === 'system39.ain') {
                lines.push('Ain ' + name);
                continue;
            }
            if (!name.toLowerCase().endsWith('.ald')) {
                continue;
            }
            let type = name.charAt(name.length - 6).toLowerCase();
            let id = name.charAt(name.length - 5);
            basename = name.slice(0, -6);
            if (!resourceType[type]) {
                console.log('Resource file of unknown type: ' + name);
                continue;
            }
            lines.push(resourceType[type] + id.toUpperCase() + ' ' + name);
            if (type == 'm')
                this.hasMidi = true;
        }
        for (let i = 0; i < 26; i++) {
            let id = String.fromCharCode(65 + i);
            lines.push('Save' + id + ' save/' + basename + 's' + id.toLowerCase() + '.asd');
        }
        lines.push(`MsgSkip save/${basename}.msgskip`);
        FS.writeFile('xsystem35.gr', lines.join('\n') + '\n');
    }
}

export class CDImageSource extends LoaderSource {
    private imageReader!: cdimage.Reader;
    private cddaCache!: CDDACache;

    constructor(private imageFile: File, private metadataFile: File | undefined, private patchFiles: File[]) {
        super();
    }

    protected async doLoad() {
        this.imageReader = await cdimage.createReader(this.imageFile, this.metadataFile);
        this.cddaCache = isMobileSafari() ? new IOSCDDACache(this.imageReader) : new BasicCDDACache(this.imageReader);
        let isofs = await cdimage.ISO9660FileSystem.create(this.imageReader);
        // this.walk(isofs, isofs.rootDir(), '/');
        let gamedata = await this.findGameDir(isofs);
        if (!gamedata)
            throw new NoGamedataError(message.no_gamedata_dir);

        let isSystem3 = !!await isofs.getDirEnt('system3.exe', gamedata);
        if (isSystem3) {
            await this.loadSystem3(await this.saveDir(isofs));
        } else {
            await this.loadXsystem35();
        }

        let endMeasure = startMeasure('ImageLoad', 'Image load', this.imageFile.name);
        for (let e of await isofs.readDir(gamedata)) {
            if (this.patchFiles.some((f) => f.name.toLowerCase() === e.name.toLowerCase()))
                continue;
            if (isSystem3) {
                if (!e.name.toLowerCase().endsWith('.dat'))
                    continue;
            } else {
                if (e.name.match(/^\.|\.(exe|dll|txt|ini)$/i))
                    continue;
            }
            let em = startMeasure(e.name);
            let chunks = await isofs.readFile(e);
            em();
            this.addFile(e.name, e.size, chunks);
        }
        for (let f of this.patchFiles) {
            let content = await readFileAsArrayBuffer(f);
            this.addFile(f.name, f.size, [new Uint8Array(content)]);
        }
        endMeasure();
    }

    getCDDA(track: number): Promise<string> {
        return this.cddaCache.getCDDA(track);
    }

    private async findGameDir(isofs: cdimage.ISO9660FileSystem): Promise<cdimage.DirEnt | null> {
        for (let e of await isofs.readDir(isofs.rootDir())) {
            if (e.isDirectory) {
                if (e.name.toLowerCase() === 'gamedata' || await isofs.getDirEnt('adisk.dat', e))
                    return e;
            }
            if (e.name.toLowerCase() === 'adisk.dat')
                return isofs.rootDir();
        }
        return null;
    }

    private async saveDir(isofs: cdimage.ISO9660FileSystem): Promise<string> {
        let dirname = isofs.volumeLabel();
        if (!dirname) {
            if (await isofs.getDirEnt('prog.bat', isofs.rootDir())) {
                dirname = 'ProG';
            } else if (await isofs.getDirEnt('dps_all.bat', isofs.rootDir())) {
                dirname = 'DPS_all';
            } else {
                dirname = 'untitled';
                ga('send', 'event', 'Loader', 'NoVolumeLabel');
            }
        }
        return '/save/' + dirname;
    }

    // For debug
    private async walk(isofs: cdimage.ISO9660FileSystem, dir: cdimage.DirEnt, dirname: string) {
        for (let e of await isofs.readDir(dir)) {
            if (e.name !== '.' && e.name !== '..') {
                console.log(dirname + e.name);
                if (e.isDirectory)
                    this.walk(isofs, e, dirname + e.name + '/');
            }
        }
    }
}

export class FileSource extends LoaderSource {
    private tracks: File[] = [];
    private trackURLs: string[] = [];
    private files: File[] = []

    constructor(fs: FileList) {
        super()
        for (let i = 0; i < fs.length; i++) {
            this.files.push(fs[i]);
        }
    }

    protected async doLoad() {
        if (this.files.some(f => f.name.toLowerCase() === 'adisk.dat')) {
            await this.loadSystem3('/save/@');
        } else {
            await this.loadXsystem35();
        }
        for (let f of this.files) {
            let match = /(\d+)\.(wav|mp3|ogg)$/.exec(f.name.toLowerCase());
            if (match) {
                this.tracks[Number(match[1])] = f;
                continue;
            }
            let content = await readFileAsArrayBuffer(f);
            this.addFile(f.name, f.size, [new Uint8Array(content)]);
        }
    }

    async getCDDA(track: number): Promise<string> {
        if (!this.trackURLs[track]) {
            if (!this.tracks[track])
                throw new Error('FileSource: Invalid track ' + track);
            this.trackURLs[track] = URL.createObjectURL(this.tracks[track]);
        }
        return this.trackURLs[track];
    }
}

export class ZipSource extends LoaderSource {
    private tracks: JSZipObject[] = [];
    private trackURLs: string[] = [];

    constructor(private zipFile: File) {
        super();
    }

    protected async doLoad() {
        await loadScript(JSZIP_SCRIPT);
        const zip = new JSZip();
        await zip.loadAsync(await readFileAsArrayBuffer(this.zipFile), JSZipOptions());

        const dataFiles = zip.file(/\.(ald|ain|dat|mda|ttf|otf|ini|xsys35rc)$/i);
        if (dataFiles.length === 0)
            throw new NoGamedataError(message.no_ald_in_zip);
        if (zip.file(/adisk.dat/i).length > 0) {
            await this.loadSystem3('/save/@');
        } else {
            await this.loadXsystem35();
        }

        for (const f of dataFiles) {
            const content: ArrayBuffer = await zip.files[f.name].async('arraybuffer');
            const basename = f.name.split('/').pop()!;
            this.addFile(basename, content.byteLength, [new Uint8Array(content)]);
        }
        for (const f of zip.file(/\d+\.(wav|mp3|ogg)$/i)) {
            const n = Number(/(\d+)\.\w+$/.exec(f.name)![1]);
            this.tracks[n] = f;
        }
    }

    async getCDDA(track: number): Promise<string> {
        if (!this.trackURLs[track]) {
            if (!this.tracks[track])
                throw new Error('ZipSource: Invalid track ' + track);
            const blob = await this.tracks[track].async('blob');
            this.trackURLs[track] = URL.createObjectURL(blob);
        }
        return this.trackURLs[track];
    }
}

type SevenZipWorkerResponse = { files: { name: string, content: Uint8Array }[] } | { error: string };
export class SevenZipSource extends LoaderSource {
    private tracks: Blob[] = [];
    private trackURLs: string[] = [];

    constructor(private file: File) {
        super();
    }

    protected async doLoad() {
        const worker = new Worker('worker/archiveworker.js');
        worker.postMessage({ file: this.file });
        $('#loader').classList.add('module-loading');  // Show the spinner
        const e = await new Promise<MessageEvent<SevenZipWorkerResponse>>((resolve) => {
            worker.addEventListener('message', (e) => resolve(e));
        });
        if ('error' in e.data) {
            $('#loader').classList.remove('module-loading');
            throw new Error(e.data.error);
        }
        const { files } = e.data;
        if (files.some(f => f.name.toLowerCase() === 'adisk.dat')) {
            await this.loadSystem3('/save/@');
        } else {
            await this.loadXsystem35();
        }

        for (const f of files) {
            let match = /(\d+)\.(wav|mp3|ogg)$/i.exec(f.name);
            if (match) {
                this.tracks[Number(match[1])] = new Blob([f.content]);
                continue;
            }
            this.addFile(f.name, f.content.byteLength, [f.content]);
        }
    }

    async getCDDA(track: number): Promise<string> {
        if (!this.trackURLs[track]) {
            if (!this.tracks[track])
                throw new Error('SevenZipSource: Invalid track ' + track);
            this.trackURLs[track] = URL.createObjectURL(this.tracks[track]);
        }
        return this.trackURLs[track];
    }
}
