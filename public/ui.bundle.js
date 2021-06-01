class DenoStdInternalError extends Error {
    constructor(message){
        super(message);
        this.name = "DenoStdInternalError";
    }
}
function assert(expr, msg = "") {
    if (!expr) {
        throw new DenoStdInternalError(msg);
    }
}
function copy(src, dst, off = 0) {
    off = Math.max(0, Math.min(off, dst.byteLength));
    const dstBytesAvailable = dst.byteLength - off;
    if (src.byteLength > dstBytesAvailable) {
        src = src.subarray(0, dstBytesAvailable);
    }
    dst.set(src, off);
    return src.byteLength;
}
const MIN_READ = 32 * 1024;
const MAX_SIZE = 2 ** 32 - 2;
class Buffer {
    #buf;
    #off = 0;
    constructor(ab){
        this.#buf = ab === undefined ? new Uint8Array(0) : new Uint8Array(ab);
    }
    bytes(options = {
        copy: true
    }) {
        if (options.copy === false) return this.#buf.subarray(this.#off);
        return this.#buf.slice(this.#off);
    }
    empty() {
        return this.#buf.byteLength <= this.#off;
    }
    get length() {
        return this.#buf.byteLength - this.#off;
    }
    get capacity() {
        return this.#buf.buffer.byteLength;
    }
    truncate(n) {
        if (n === 0) {
            this.reset();
            return;
        }
        if (n < 0 || n > this.length) {
            throw Error("bytes.Buffer: truncation out of range");
        }
        this.#reslice(this.#off + n);
    }
    reset() {
        this.#reslice(0);
        this.#off = 0;
    }
    #tryGrowByReslice = (n)=>{
        const l = this.#buf.byteLength;
        if (n <= this.capacity - l) {
            this.#reslice(l + n);
            return l;
        }
        return -1;
    };
    #reslice = (len)=>{
        assert(len <= this.#buf.buffer.byteLength);
        this.#buf = new Uint8Array(this.#buf.buffer, 0, len);
    };
    readSync(p) {
        if (this.empty()) {
            this.reset();
            if (p.byteLength === 0) {
                return 0;
            }
            return null;
        }
        const nread = copy(this.#buf.subarray(this.#off), p);
        this.#off += nread;
        return nread;
    }
    read(p) {
        const rr = this.readSync(p);
        return Promise.resolve(rr);
    }
    writeSync(p) {
        const m = this.#grow(p.byteLength);
        return copy(p, this.#buf, m);
    }
    write(p) {
        const n = this.writeSync(p);
        return Promise.resolve(n);
    }
    #grow = (n)=>{
        const m = this.length;
        if (m === 0 && this.#off !== 0) {
            this.reset();
        }
        const i = this.#tryGrowByReslice(n);
        if (i >= 0) {
            return i;
        }
        const c = this.capacity;
        if (n <= Math.floor(c / 2) - m) {
            copy(this.#buf.subarray(this.#off), this.#buf);
        } else if (c + n > MAX_SIZE) {
            throw new Error("The buffer cannot be grown beyond the maximum size.");
        } else {
            const buf = new Uint8Array(Math.min(2 * c + n, MAX_SIZE));
            copy(this.#buf.subarray(this.#off), buf);
            this.#buf = buf;
        }
        this.#off = 0;
        this.#reslice(Math.min(m + n, MAX_SIZE));
        return m;
    };
    grow(n) {
        if (n < 0) {
            throw Error("Buffer.grow: negative count");
        }
        const m = this.#grow(n);
        this.#reslice(m);
    }
    async readFrom(r) {
        let n = 0;
        const tmp = new Uint8Array(MIN_READ);
        while(true){
            const shouldGrow = this.capacity - this.length < MIN_READ;
            const buf = shouldGrow ? tmp : new Uint8Array(this.#buf.buffer, this.length);
            const nread = await r.read(buf);
            if (nread === null) {
                return n;
            }
            if (shouldGrow) this.writeSync(buf.subarray(0, nread));
            else this.#reslice(this.length + nread);
            n += nread;
        }
    }
    readFromSync(r) {
        let n = 0;
        const tmp = new Uint8Array(MIN_READ);
        while(true){
            const shouldGrow = this.capacity - this.length < MIN_READ;
            const buf = shouldGrow ? tmp : new Uint8Array(this.#buf.buffer, this.length);
            const nread = r.readSync(buf);
            if (nread === null) {
                return n;
            }
            if (shouldGrow) this.writeSync(buf.subarray(0, nread));
            else this.#reslice(this.length + nread);
            n += nread;
        }
    }
}
class BytesList {
    len = 0;
    chunks = [];
    constructor(){
    }
    size() {
        return this.len;
    }
    add(value, start = 0, end = value.byteLength) {
        if (value.byteLength === 0 || end - start === 0) {
            return;
        }
        checkRange(start, end, value.byteLength);
        this.chunks.push({
            value,
            end,
            start,
            offset: this.len
        });
        this.len += end - start;
    }
    shift(n) {
        if (n === 0) {
            return;
        }
        if (this.len <= n) {
            this.chunks = [];
            this.len = 0;
            return;
        }
        const idx = this.getChunkIndex(n);
        this.chunks.splice(0, idx);
        const [chunk] = this.chunks;
        if (chunk) {
            const diff = n - chunk.offset;
            chunk.start += diff;
        }
        let offset = 0;
        for (const chunk1 of this.chunks){
            chunk1.offset = offset;
            offset += chunk1.end - chunk1.start;
        }
        this.len = offset;
    }
    getChunkIndex(pos) {
        let max = this.chunks.length;
        let min = 0;
        while(true){
            const i = min + Math.floor((max - min) / 2);
            if (i < 0 || this.chunks.length <= i) {
                return -1;
            }
            const { offset , start , end  } = this.chunks[i];
            const len = end - start;
            if (offset <= pos && pos < offset + len) {
                return i;
            } else if (offset + len <= pos) {
                min = i + 1;
            } else {
                max = i - 1;
            }
        }
    }
    get(i) {
        if (i < 0 || this.len <= i) {
            throw new Error("out of range");
        }
        const idx = this.getChunkIndex(i);
        const { value , offset , start  } = this.chunks[idx];
        return value[start + i - offset];
    }
    *iterator(start = 0) {
        const startIdx = this.getChunkIndex(start);
        if (startIdx < 0) return;
        const first = this.chunks[startIdx];
        let firstOffset = start - first.offset;
        for(let i = startIdx; i < this.chunks.length; i++){
            const chunk = this.chunks[i];
            for(let j = chunk.start + firstOffset; j < chunk.end; j++){
                yield chunk.value[j];
            }
            firstOffset = 0;
        }
    }
    slice(start, end = this.len) {
        if (end === start) {
            return new Uint8Array();
        }
        checkRange(start, end, this.len);
        const result = new Uint8Array(end - start);
        const startIdx = this.getChunkIndex(start);
        const endIdx = this.getChunkIndex(end - 1);
        let written = 0;
        for(let i = startIdx; i < endIdx; i++){
            const chunk = this.chunks[i];
            const len = chunk.end - chunk.start;
            result.set(chunk.value.subarray(chunk.start, chunk.end), written);
            written += len;
        }
        const last = this.chunks[endIdx];
        const rest = end - start - written;
        result.set(last.value.subarray(last.start, last.start + rest), written);
        return result;
    }
    concat() {
        const result = new Uint8Array(this.len);
        let sum = 0;
        for (const { value , start , end  } of this.chunks){
            result.set(value.subarray(start, end), sum);
            sum += end - start;
        }
        return result;
    }
}
function checkRange(start, end, len) {
    if (start < 0 || len < start || end < 0 || len < end || end < start) {
        throw new Error("invalid range");
    }
}
const ANSI_PATTERN = new RegExp([
    "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)",
    "(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))", 
].join("|"), "g");
var DiffType;
(function(DiffType1) {
    DiffType1["removed"] = "removed";
    DiffType1["common"] = "common";
    DiffType1["added"] = "added";
})(DiffType || (DiffType = {
}));
class AssertionError extends Error {
    constructor(message1){
        super(message1);
        this.name = "AssertionError";
    }
}
async function writeAll(w, arr) {
    let nwritten = 0;
    while(nwritten < arr.length){
        nwritten += await w.write(arr.subarray(nwritten));
    }
}
function writeAllSync(w, arr) {
    let nwritten = 0;
    while(nwritten < arr.length){
        nwritten += w.writeSync(arr.subarray(nwritten));
    }
}
const DEFAULT_BUF_SIZE = 4096;
const MIN_BUF_SIZE = 16;
const CR = "\r".charCodeAt(0);
const LF = "\n".charCodeAt(0);
class BufferFullError extends Error {
    partial;
    name = "BufferFullError";
    constructor(partial1){
        super("Buffer full");
        this.partial = partial1;
    }
}
class PartialReadError extends Error {
    name = "PartialReadError";
    partial;
    constructor(){
        super("Encountered UnexpectedEof, data only partially read");
    }
}
class BufReader {
    buf;
    rd;
    r = 0;
    w = 0;
    eof = false;
    static create(r, size = 4096) {
        return r instanceof BufReader ? r : new BufReader(r, size);
    }
    constructor(rd1, size1 = 4096){
        if (size1 < 16) {
            size1 = MIN_BUF_SIZE;
        }
        this._reset(new Uint8Array(size1), rd1);
    }
    size() {
        return this.buf.byteLength;
    }
    buffered() {
        return this.w - this.r;
    }
    async _fill() {
        if (this.r > 0) {
            this.buf.copyWithin(0, this.r, this.w);
            this.w -= this.r;
            this.r = 0;
        }
        if (this.w >= this.buf.byteLength) {
            throw Error("bufio: tried to fill full buffer");
        }
        for(let i = 100; i > 0; i--){
            const rr = await this.rd.read(this.buf.subarray(this.w));
            if (rr === null) {
                this.eof = true;
                return;
            }
            assert(rr >= 0, "negative read");
            this.w += rr;
            if (rr > 0) {
                return;
            }
        }
        throw new Error(`No progress after ${100} read() calls`);
    }
    reset(r) {
        this._reset(this.buf, r);
    }
    _reset(buf, rd) {
        this.buf = buf;
        this.rd = rd;
        this.eof = false;
    }
    async read(p) {
        let rr = p.byteLength;
        if (p.byteLength === 0) return rr;
        if (this.r === this.w) {
            if (p.byteLength >= this.buf.byteLength) {
                const rr1 = await this.rd.read(p);
                const nread = rr1 ?? 0;
                assert(nread >= 0, "negative read");
                return rr1;
            }
            this.r = 0;
            this.w = 0;
            rr = await this.rd.read(this.buf);
            if (rr === 0 || rr === null) return rr;
            assert(rr >= 0, "negative read");
            this.w += rr;
        }
        const copied = copy(this.buf.subarray(this.r, this.w), p, 0);
        this.r += copied;
        return copied;
    }
    async readFull(p) {
        let bytesRead = 0;
        while(bytesRead < p.length){
            try {
                const rr = await this.read(p.subarray(bytesRead));
                if (rr === null) {
                    if (bytesRead === 0) {
                        return null;
                    } else {
                        throw new PartialReadError();
                    }
                }
                bytesRead += rr;
            } catch (err) {
                err.partial = p.subarray(0, bytesRead);
                throw err;
            }
        }
        return p;
    }
    async readByte() {
        while(this.r === this.w){
            if (this.eof) return null;
            await this._fill();
        }
        const c = this.buf[this.r];
        this.r++;
        return c;
    }
    async readString(delim) {
        if (delim.length !== 1) {
            throw new Error("Delimiter should be a single character");
        }
        const buffer = await this.readSlice(delim.charCodeAt(0));
        if (buffer === null) return null;
        return new TextDecoder().decode(buffer);
    }
    async readLine() {
        let line;
        try {
            line = await this.readSlice(LF);
        } catch (err) {
            let { partial: partial2  } = err;
            assert(partial2 instanceof Uint8Array, "bufio: caught error from `readSlice()` without `partial` property");
            if (!(err instanceof BufferFullError)) {
                throw err;
            }
            if (!this.eof && partial2.byteLength > 0 && partial2[partial2.byteLength - 1] === CR) {
                assert(this.r > 0, "bufio: tried to rewind past start of buffer");
                this.r--;
                partial2 = partial2.subarray(0, partial2.byteLength - 1);
            }
            return {
                line: partial2,
                more: !this.eof
            };
        }
        if (line === null) {
            return null;
        }
        if (line.byteLength === 0) {
            return {
                line,
                more: false
            };
        }
        if (line[line.byteLength - 1] == LF) {
            let drop = 1;
            if (line.byteLength > 1 && line[line.byteLength - 2] === CR) {
                drop = 2;
            }
            line = line.subarray(0, line.byteLength - drop);
        }
        return {
            line,
            more: false
        };
    }
    async readSlice(delim) {
        let s = 0;
        let slice;
        while(true){
            let i = this.buf.subarray(this.r + s, this.w).indexOf(delim);
            if (i >= 0) {
                i += s;
                slice = this.buf.subarray(this.r, this.r + i + 1);
                this.r += i + 1;
                break;
            }
            if (this.eof) {
                if (this.r === this.w) {
                    return null;
                }
                slice = this.buf.subarray(this.r, this.w);
                this.r = this.w;
                break;
            }
            if (this.buffered() >= this.buf.byteLength) {
                this.r = this.w;
                const oldbuf = this.buf;
                const newbuf = this.buf.slice(0);
                this.buf = newbuf;
                throw new BufferFullError(oldbuf);
            }
            s = this.w - this.r;
            try {
                await this._fill();
            } catch (err) {
                err.partial = slice;
                throw err;
            }
        }
        return slice;
    }
    async peek(n) {
        if (n < 0) {
            throw Error("negative count");
        }
        let avail = this.w - this.r;
        while(avail < n && avail < this.buf.byteLength && !this.eof){
            try {
                await this._fill();
            } catch (err) {
                err.partial = this.buf.subarray(this.r, this.w);
                throw err;
            }
            avail = this.w - this.r;
        }
        if (avail === 0 && this.eof) {
            return null;
        } else if (avail < n && this.eof) {
            return this.buf.subarray(this.r, this.r + avail);
        } else if (avail < n) {
            throw new BufferFullError(this.buf.subarray(this.r, this.w));
        }
        return this.buf.subarray(this.r, this.r + n);
    }
}
class AbstractBufBase {
    buf;
    usedBufferBytes = 0;
    err = null;
    size() {
        return this.buf.byteLength;
    }
    available() {
        return this.buf.byteLength - this.usedBufferBytes;
    }
    buffered() {
        return this.usedBufferBytes;
    }
}
class BufWriter extends AbstractBufBase {
    writer;
    static create(writer, size = 4096) {
        return writer instanceof BufWriter ? writer : new BufWriter(writer, size);
    }
    constructor(writer1, size2 = 4096){
        super();
        this.writer = writer1;
        if (size2 <= 0) {
            size2 = DEFAULT_BUF_SIZE;
        }
        this.buf = new Uint8Array(size2);
    }
    reset(w) {
        this.err = null;
        this.usedBufferBytes = 0;
        this.writer = w;
    }
    async flush() {
        if (this.err !== null) throw this.err;
        if (this.usedBufferBytes === 0) return;
        try {
            await writeAll(this.writer, this.buf.subarray(0, this.usedBufferBytes));
        } catch (e) {
            this.err = e;
            throw e;
        }
        this.buf = new Uint8Array(this.buf.length);
        this.usedBufferBytes = 0;
    }
    async write(data) {
        if (this.err !== null) throw this.err;
        if (data.length === 0) return 0;
        let totalBytesWritten = 0;
        let numBytesWritten = 0;
        while(data.byteLength > this.available()){
            if (this.buffered() === 0) {
                try {
                    numBytesWritten = await this.writer.write(data);
                } catch (e) {
                    this.err = e;
                    throw e;
                }
            } else {
                numBytesWritten = copy(data, this.buf, this.usedBufferBytes);
                this.usedBufferBytes += numBytesWritten;
                await this.flush();
            }
            totalBytesWritten += numBytesWritten;
            data = data.subarray(numBytesWritten);
        }
        numBytesWritten = copy(data, this.buf, this.usedBufferBytes);
        this.usedBufferBytes += numBytesWritten;
        totalBytesWritten += numBytesWritten;
        return totalBytesWritten;
    }
}
class BufWriterSync extends AbstractBufBase {
    writer;
    static create(writer, size = 4096) {
        return writer instanceof BufWriterSync ? writer : new BufWriterSync(writer, size);
    }
    constructor(writer2, size3 = 4096){
        super();
        this.writer = writer2;
        if (size3 <= 0) {
            size3 = DEFAULT_BUF_SIZE;
        }
        this.buf = new Uint8Array(size3);
    }
    reset(w) {
        this.err = null;
        this.usedBufferBytes = 0;
        this.writer = w;
    }
    flush() {
        if (this.err !== null) throw this.err;
        if (this.usedBufferBytes === 0) return;
        try {
            writeAllSync(this.writer, this.buf.subarray(0, this.usedBufferBytes));
        } catch (e) {
            this.err = e;
            throw e;
        }
        this.buf = new Uint8Array(this.buf.length);
        this.usedBufferBytes = 0;
    }
    writeSync(data) {
        if (this.err !== null) throw this.err;
        if (data.length === 0) return 0;
        let totalBytesWritten = 0;
        let numBytesWritten = 0;
        while(data.byteLength > this.available()){
            if (this.buffered() === 0) {
                try {
                    numBytesWritten = this.writer.writeSync(data);
                } catch (e) {
                    this.err = e;
                    throw e;
                }
            } else {
                numBytesWritten = copy(data, this.buf, this.usedBufferBytes);
                this.usedBufferBytes += numBytesWritten;
                this.flush();
            }
            totalBytesWritten += numBytesWritten;
            data = data.subarray(numBytesWritten);
        }
        numBytesWritten = copy(data, this.buf, this.usedBufferBytes);
        this.usedBufferBytes += numBytesWritten;
        totalBytesWritten += numBytesWritten;
        return totalBytesWritten;
    }
}
function createLPS(pat) {
    const lps = new Uint8Array(pat.length);
    lps[0] = 0;
    let prefixEnd = 0;
    let i = 1;
    while(i < lps.length){
        if (pat[i] == pat[prefixEnd]) {
            prefixEnd++;
            lps[i] = prefixEnd;
            i++;
        } else if (prefixEnd === 0) {
            lps[i] = 0;
            i++;
        } else {
            prefixEnd = lps[prefixEnd - 1];
        }
    }
    return lps;
}
async function* readDelim(reader, delim) {
    const delimLen = delim.length;
    const delimLPS = createLPS(delim);
    const chunks = new BytesList();
    const bufSize = Math.max(1024, delimLen + 1);
    let inspectIndex = 0;
    let matchIndex = 0;
    while(true){
        const inspectArr = new Uint8Array(bufSize);
        const result = await reader.read(inspectArr);
        if (result === null) {
            yield chunks.concat();
            return;
        } else if (result < 0) {
            return;
        }
        chunks.add(inspectArr, 0, result);
        let localIndex = 0;
        while(inspectIndex < chunks.size()){
            if (inspectArr[localIndex] === delim[matchIndex]) {
                inspectIndex++;
                localIndex++;
                matchIndex++;
                if (matchIndex === delimLen) {
                    const matchEnd = inspectIndex - delimLen;
                    const readyBytes = chunks.slice(0, matchEnd);
                    yield readyBytes;
                    chunks.shift(inspectIndex);
                    inspectIndex = 0;
                    matchIndex = 0;
                }
            } else {
                if (matchIndex === 0) {
                    inspectIndex++;
                    localIndex++;
                } else {
                    matchIndex = delimLPS[matchIndex - 1];
                }
            }
        }
    }
}
async function* readStringDelim(reader, delim) {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    for await (const chunk of readDelim(reader, encoder.encode(delim))){
        yield decoder.decode(chunk);
    }
}
async function* readLines(reader) {
    for await (let chunk of readStringDelim(reader, "\n")){
        if (chunk.endsWith("\r")) {
            chunk = chunk.slice(0, -1);
        }
        yield chunk;
    }
}
class StringReader extends Buffer {
    constructor(s){
        super(new TextEncoder().encode(s).buffer);
    }
}
class MultiReader {
    readers;
    currentIndex = 0;
    constructor(...readers){
        this.readers = readers;
    }
    async read(p) {
        const r = this.readers[this.currentIndex];
        if (!r) return null;
        const result = await r.read(p);
        if (result === null) {
            this.currentIndex++;
            return 0;
        }
        return result;
    }
}
class LimitedReader {
    reader;
    limit;
    constructor(reader, limit){
        this.reader = reader;
        this.limit = limit;
    }
    async read(p) {
        if (this.limit <= 0) {
            return null;
        }
        if (p.length > this.limit) {
            p = p.subarray(0, this.limit);
        }
        const n = await this.reader.read(p);
        if (n == null) {
            return null;
        }
        this.limit -= n;
        return n;
    }
}
function readerFromStreamReader(streamReader) {
    const buffer = new Buffer();
    return {
        async read (p) {
            if (buffer.empty()) {
                const res = await streamReader.read();
                if (res.done) {
                    return null;
                }
                await writeAll(buffer, res.value);
            }
            return buffer.read(p);
        }
    };
}
const decoder = new TextDecoder();
class StringWriter {
    base;
    chunks = [];
    byteLength = 0;
    cache;
    constructor(base = ""){
        this.base = base;
        const c = new TextEncoder().encode(base);
        this.chunks.push(c);
        this.byteLength += c.byteLength;
    }
    write(p) {
        return Promise.resolve(this.writeSync(p));
    }
    writeSync(p) {
        this.chunks.push(p);
        this.byteLength += p.byteLength;
        this.cache = undefined;
        return p.byteLength;
    }
    toString() {
        if (this.cache) {
            return this.cache;
        }
        const buf = new Uint8Array(this.byteLength);
        let offs = 0;
        for (const chunk of this.chunks){
            buf.set(chunk, offs);
            offs += chunk.byteLength;
        }
        this.cache = decoder.decode(buf);
        return this.cache;
    }
}
function delay(ms) {
    return new Promise((res)=>setTimeout(()=>{
            res();
        }, ms)
    );
}
const emojis = [
    {
        emoji: "😀",
        description: "grinning face",
        category: "Smileys & Emotion",
        aliases: [
            "grinning"
        ],
        tags: [
            "smile",
            "happy"
        ],
        unicodeVersion: "6.1",
        iosVersion: "6.0"
    },
    {
        emoji: "😃",
        description: "grinning face with big eyes",
        category: "Smileys & Emotion",
        aliases: [
            "smiley"
        ],
        tags: [
            "happy",
            "joy",
            "haha"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "😄",
        description: "grinning face with smiling eyes",
        category: "Smileys & Emotion",
        aliases: [
            "smile"
        ],
        tags: [
            "happy",
            "joy",
            "laugh",
            "pleased"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "😁",
        description: "beaming face with smiling eyes",
        category: "Smileys & Emotion",
        aliases: [
            "grin"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "😆",
        description: "grinning squinting face",
        category: "Smileys & Emotion",
        aliases: [
            "laughing",
            "satisfied"
        ],
        tags: [
            "happy",
            "haha"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "😅",
        description: "grinning face with sweat",
        category: "Smileys & Emotion",
        aliases: [
            "sweat_smile"
        ],
        tags: [
            "hot"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🤣",
        description: "rolling on the floor laughing",
        category: "Smileys & Emotion",
        aliases: [
            "rofl"
        ],
        tags: [
            "lol",
            "laughing"
        ],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "😂",
        description: "face with tears of joy",
        category: "Smileys & Emotion",
        aliases: [
            "joy"
        ],
        tags: [
            "tears"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🙂",
        description: "slightly smiling face",
        category: "Smileys & Emotion",
        aliases: [
            "slightly_smiling_face"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🙃",
        description: "upside-down face",
        category: "Smileys & Emotion",
        aliases: [
            "upside_down_face"
        ],
        tags: [],
        unicodeVersion: "8.0",
        iosVersion: "9.1"
    },
    {
        emoji: "😉",
        description: "winking face",
        category: "Smileys & Emotion",
        aliases: [
            "wink"
        ],
        tags: [
            "flirt"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "😊",
        description: "smiling face with smiling eyes",
        category: "Smileys & Emotion",
        aliases: [
            "blush"
        ],
        tags: [
            "proud"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "😇",
        description: "smiling face with halo",
        category: "Smileys & Emotion",
        aliases: [
            "innocent"
        ],
        tags: [
            "angel"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🥰",
        description: "smiling face with hearts",
        category: "Smileys & Emotion",
        aliases: [
            "smiling_face_with_three_hearts"
        ],
        tags: [
            "love"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "😍",
        description: "smiling face with heart-eyes",
        category: "Smileys & Emotion",
        aliases: [
            "heart_eyes"
        ],
        tags: [
            "love",
            "crush"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🤩",
        description: "star-struck",
        category: "Smileys & Emotion",
        aliases: [
            "star_struck"
        ],
        tags: [
            "eyes"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "😘",
        description: "face blowing a kiss",
        category: "Smileys & Emotion",
        aliases: [
            "kissing_heart"
        ],
        tags: [
            "flirt"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "😗",
        description: "kissing face",
        category: "Smileys & Emotion",
        aliases: [
            "kissing"
        ],
        tags: [],
        unicodeVersion: "6.1",
        iosVersion: "6.0"
    },
    {
        emoji: "☺️",
        description: "smiling face",
        category: "Smileys & Emotion",
        aliases: [
            "relaxed"
        ],
        tags: [
            "blush",
            "pleased"
        ],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "😚",
        description: "kissing face with closed eyes",
        category: "Smileys & Emotion",
        aliases: [
            "kissing_closed_eyes"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "😙",
        description: "kissing face with smiling eyes",
        category: "Smileys & Emotion",
        aliases: [
            "kissing_smiling_eyes"
        ],
        tags: [],
        unicodeVersion: "6.1",
        iosVersion: "6.0"
    },
    {
        emoji: "🥲",
        description: "smiling face with tear",
        category: "Smileys & Emotion",
        aliases: [
            "smiling_face_with_tear"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "😋",
        description: "face savoring food",
        category: "Smileys & Emotion",
        aliases: [
            "yum"
        ],
        tags: [
            "tongue",
            "lick"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "😛",
        description: "face with tongue",
        category: "Smileys & Emotion",
        aliases: [
            "stuck_out_tongue"
        ],
        tags: [],
        unicodeVersion: "6.1",
        iosVersion: "6.0"
    },
    {
        emoji: "😜",
        description: "winking face with tongue",
        category: "Smileys & Emotion",
        aliases: [
            "stuck_out_tongue_winking_eye"
        ],
        tags: [
            "prank",
            "silly"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🤪",
        description: "zany face",
        category: "Smileys & Emotion",
        aliases: [
            "zany_face"
        ],
        tags: [
            "goofy",
            "wacky"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "😝",
        description: "squinting face with tongue",
        category: "Smileys & Emotion",
        aliases: [
            "stuck_out_tongue_closed_eyes"
        ],
        tags: [
            "prank"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🤑",
        description: "money-mouth face",
        category: "Smileys & Emotion",
        aliases: [
            "money_mouth_face"
        ],
        tags: [
            "rich"
        ],
        unicodeVersion: "8.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🤗",
        description: "hugging face",
        category: "Smileys & Emotion",
        aliases: [
            "hugs"
        ],
        tags: [],
        unicodeVersion: "8.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🤭",
        description: "face with hand over mouth",
        category: "Smileys & Emotion",
        aliases: [
            "hand_over_mouth"
        ],
        tags: [
            "quiet",
            "whoops"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🤫",
        description: "shushing face",
        category: "Smileys & Emotion",
        aliases: [
            "shushing_face"
        ],
        tags: [
            "silence",
            "quiet"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🤔",
        description: "thinking face",
        category: "Smileys & Emotion",
        aliases: [
            "thinking"
        ],
        tags: [],
        unicodeVersion: "8.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🤐",
        description: "zipper-mouth face",
        category: "Smileys & Emotion",
        aliases: [
            "zipper_mouth_face"
        ],
        tags: [
            "silence",
            "hush"
        ],
        unicodeVersion: "8.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🤨",
        description: "face with raised eyebrow",
        category: "Smileys & Emotion",
        aliases: [
            "raised_eyebrow"
        ],
        tags: [
            "suspicious"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "😐",
        description: "neutral face",
        category: "Smileys & Emotion",
        aliases: [
            "neutral_face"
        ],
        tags: [
            "meh"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "😑",
        description: "expressionless face",
        category: "Smileys & Emotion",
        aliases: [
            "expressionless"
        ],
        tags: [],
        unicodeVersion: "6.1",
        iosVersion: "6.0"
    },
    {
        emoji: "😶",
        description: "face without mouth",
        category: "Smileys & Emotion",
        aliases: [
            "no_mouth"
        ],
        tags: [
            "mute",
            "silence"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "😏",
        description: "smirking face",
        category: "Smileys & Emotion",
        aliases: [
            "smirk"
        ],
        tags: [
            "smug"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "😒",
        description: "unamused face",
        category: "Smileys & Emotion",
        aliases: [
            "unamused"
        ],
        tags: [
            "meh"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🙄",
        description: "face with rolling eyes",
        category: "Smileys & Emotion",
        aliases: [
            "roll_eyes"
        ],
        tags: [],
        unicodeVersion: "8.0",
        iosVersion: "9.1"
    },
    {
        emoji: "😬",
        description: "grimacing face",
        category: "Smileys & Emotion",
        aliases: [
            "grimacing"
        ],
        tags: [],
        unicodeVersion: "6.1",
        iosVersion: "6.0"
    },
    {
        emoji: "🤥",
        description: "lying face",
        category: "Smileys & Emotion",
        aliases: [
            "lying_face"
        ],
        tags: [
            "liar"
        ],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "😌",
        description: "relieved face",
        category: "Smileys & Emotion",
        aliases: [
            "relieved"
        ],
        tags: [
            "whew"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "😔",
        description: "pensive face",
        category: "Smileys & Emotion",
        aliases: [
            "pensive"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "😪",
        description: "sleepy face",
        category: "Smileys & Emotion",
        aliases: [
            "sleepy"
        ],
        tags: [
            "tired"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🤤",
        description: "drooling face",
        category: "Smileys & Emotion",
        aliases: [
            "drooling_face"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "😴",
        description: "sleeping face",
        category: "Smileys & Emotion",
        aliases: [
            "sleeping"
        ],
        tags: [
            "zzz"
        ],
        unicodeVersion: "6.1",
        iosVersion: "6.0"
    },
    {
        emoji: "😷",
        description: "face with medical mask",
        category: "Smileys & Emotion",
        aliases: [
            "mask"
        ],
        tags: [
            "sick",
            "ill"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🤒",
        description: "face with thermometer",
        category: "Smileys & Emotion",
        aliases: [
            "face_with_thermometer"
        ],
        tags: [
            "sick"
        ],
        unicodeVersion: "8.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🤕",
        description: "face with head-bandage",
        category: "Smileys & Emotion",
        aliases: [
            "face_with_head_bandage"
        ],
        tags: [
            "hurt"
        ],
        unicodeVersion: "8.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🤢",
        description: "nauseated face",
        category: "Smileys & Emotion",
        aliases: [
            "nauseated_face"
        ],
        tags: [
            "sick",
            "barf",
            "disgusted"
        ],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🤮",
        description: "face vomiting",
        category: "Smileys & Emotion",
        aliases: [
            "vomiting_face"
        ],
        tags: [
            "barf",
            "sick"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🤧",
        description: "sneezing face",
        category: "Smileys & Emotion",
        aliases: [
            "sneezing_face"
        ],
        tags: [
            "achoo",
            "sick"
        ],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🥵",
        description: "hot face",
        category: "Smileys & Emotion",
        aliases: [
            "hot_face"
        ],
        tags: [
            "heat",
            "sweating"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🥶",
        description: "cold face",
        category: "Smileys & Emotion",
        aliases: [
            "cold_face"
        ],
        tags: [
            "freezing",
            "ice"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🥴",
        description: "woozy face",
        category: "Smileys & Emotion",
        aliases: [
            "woozy_face"
        ],
        tags: [
            "groggy"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "😵",
        description: "dizzy face",
        category: "Smileys & Emotion",
        aliases: [
            "dizzy_face"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🤯",
        description: "exploding head",
        category: "Smileys & Emotion",
        aliases: [
            "exploding_head"
        ],
        tags: [
            "mind",
            "blown"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🤠",
        description: "cowboy hat face",
        category: "Smileys & Emotion",
        aliases: [
            "cowboy_hat_face"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🥳",
        description: "partying face",
        category: "Smileys & Emotion",
        aliases: [
            "partying_face"
        ],
        tags: [
            "celebration",
            "birthday"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🥸",
        description: "disguised face",
        category: "Smileys & Emotion",
        aliases: [
            "disguised_face"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "😎",
        description: "smiling face with sunglasses",
        category: "Smileys & Emotion",
        aliases: [
            "sunglasses"
        ],
        tags: [
            "cool"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🤓",
        description: "nerd face",
        category: "Smileys & Emotion",
        aliases: [
            "nerd_face"
        ],
        tags: [
            "geek",
            "glasses"
        ],
        unicodeVersion: "8.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🧐",
        description: "face with monocle",
        category: "Smileys & Emotion",
        aliases: [
            "monocle_face"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "😕",
        description: "confused face",
        category: "Smileys & Emotion",
        aliases: [
            "confused"
        ],
        tags: [],
        unicodeVersion: "6.1",
        iosVersion: "6.0"
    },
    {
        emoji: "😟",
        description: "worried face",
        category: "Smileys & Emotion",
        aliases: [
            "worried"
        ],
        tags: [
            "nervous"
        ],
        unicodeVersion: "6.1",
        iosVersion: "6.0"
    },
    {
        emoji: "🙁",
        description: "slightly frowning face",
        category: "Smileys & Emotion",
        aliases: [
            "slightly_frowning_face"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "☹️",
        description: "frowning face",
        category: "Smileys & Emotion",
        aliases: [
            "frowning_face"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "9.1"
    },
    {
        emoji: "😮",
        description: "face with open mouth",
        category: "Smileys & Emotion",
        aliases: [
            "open_mouth"
        ],
        tags: [
            "surprise",
            "impressed",
            "wow"
        ],
        unicodeVersion: "6.1",
        iosVersion: "6.0"
    },
    {
        emoji: "😯",
        description: "hushed face",
        category: "Smileys & Emotion",
        aliases: [
            "hushed"
        ],
        tags: [
            "silence",
            "speechless"
        ],
        unicodeVersion: "6.1",
        iosVersion: "6.0"
    },
    {
        emoji: "😲",
        description: "astonished face",
        category: "Smileys & Emotion",
        aliases: [
            "astonished"
        ],
        tags: [
            "amazed",
            "gasp"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "😳",
        description: "flushed face",
        category: "Smileys & Emotion",
        aliases: [
            "flushed"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🥺",
        description: "pleading face",
        category: "Smileys & Emotion",
        aliases: [
            "pleading_face"
        ],
        tags: [
            "puppy",
            "eyes"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "😦",
        description: "frowning face with open mouth",
        category: "Smileys & Emotion",
        aliases: [
            "frowning"
        ],
        tags: [],
        unicodeVersion: "6.1",
        iosVersion: "6.0"
    },
    {
        emoji: "😧",
        description: "anguished face",
        category: "Smileys & Emotion",
        aliases: [
            "anguished"
        ],
        tags: [
            "stunned"
        ],
        unicodeVersion: "6.1",
        iosVersion: "6.0"
    },
    {
        emoji: "😨",
        description: "fearful face",
        category: "Smileys & Emotion",
        aliases: [
            "fearful"
        ],
        tags: [
            "scared",
            "shocked",
            "oops"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "😰",
        description: "anxious face with sweat",
        category: "Smileys & Emotion",
        aliases: [
            "cold_sweat"
        ],
        tags: [
            "nervous"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "😥",
        description: "sad but relieved face",
        category: "Smileys & Emotion",
        aliases: [
            "disappointed_relieved"
        ],
        tags: [
            "phew",
            "sweat",
            "nervous"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "😢",
        description: "crying face",
        category: "Smileys & Emotion",
        aliases: [
            "cry"
        ],
        tags: [
            "sad",
            "tear"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "😭",
        description: "loudly crying face",
        category: "Smileys & Emotion",
        aliases: [
            "sob"
        ],
        tags: [
            "sad",
            "cry",
            "bawling"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "😱",
        description: "face screaming in fear",
        category: "Smileys & Emotion",
        aliases: [
            "scream"
        ],
        tags: [
            "horror",
            "shocked"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "😖",
        description: "confounded face",
        category: "Smileys & Emotion",
        aliases: [
            "confounded"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "😣",
        description: "persevering face",
        category: "Smileys & Emotion",
        aliases: [
            "persevere"
        ],
        tags: [
            "struggling"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "😞",
        description: "disappointed face",
        category: "Smileys & Emotion",
        aliases: [
            "disappointed"
        ],
        tags: [
            "sad"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "😓",
        description: "downcast face with sweat",
        category: "Smileys & Emotion",
        aliases: [
            "sweat"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "😩",
        description: "weary face",
        category: "Smileys & Emotion",
        aliases: [
            "weary"
        ],
        tags: [
            "tired"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "😫",
        description: "tired face",
        category: "Smileys & Emotion",
        aliases: [
            "tired_face"
        ],
        tags: [
            "upset",
            "whine"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🥱",
        description: "yawning face",
        category: "Smileys & Emotion",
        aliases: [
            "yawning_face"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "😤",
        description: "face with steam from nose",
        category: "Smileys & Emotion",
        aliases: [
            "triumph"
        ],
        tags: [
            "smug"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "😡",
        description: "pouting face",
        category: "Smileys & Emotion",
        aliases: [
            "rage",
            "pout"
        ],
        tags: [
            "angry"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "😠",
        description: "angry face",
        category: "Smileys & Emotion",
        aliases: [
            "angry"
        ],
        tags: [
            "mad",
            "annoyed"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🤬",
        description: "face with symbols on mouth",
        category: "Smileys & Emotion",
        aliases: [
            "cursing_face"
        ],
        tags: [
            "foul"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "😈",
        description: "smiling face with horns",
        category: "Smileys & Emotion",
        aliases: [
            "smiling_imp"
        ],
        tags: [
            "devil",
            "evil",
            "horns"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "👿",
        description: "angry face with horns",
        category: "Smileys & Emotion",
        aliases: [
            "imp"
        ],
        tags: [
            "angry",
            "devil",
            "evil",
            "horns"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💀",
        description: "skull",
        category: "Smileys & Emotion",
        aliases: [
            "skull"
        ],
        tags: [
            "dead",
            "danger",
            "poison"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "☠️",
        description: "skull and crossbones",
        category: "Smileys & Emotion",
        aliases: [
            "skull_and_crossbones"
        ],
        tags: [
            "danger",
            "pirate"
        ],
        unicodeVersion: "",
        iosVersion: "9.1"
    },
    {
        emoji: "💩",
        description: "pile of poo",
        category: "Smileys & Emotion",
        aliases: [
            "hankey",
            "poop",
            "shit"
        ],
        tags: [
            "crap"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🤡",
        description: "clown face",
        category: "Smileys & Emotion",
        aliases: [
            "clown_face"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "👹",
        description: "ogre",
        category: "Smileys & Emotion",
        aliases: [
            "japanese_ogre"
        ],
        tags: [
            "monster"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "👺",
        description: "goblin",
        category: "Smileys & Emotion",
        aliases: [
            "japanese_goblin"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "👻",
        description: "ghost",
        category: "Smileys & Emotion",
        aliases: [
            "ghost"
        ],
        tags: [
            "halloween"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "👽",
        description: "alien",
        category: "Smileys & Emotion",
        aliases: [
            "alien"
        ],
        tags: [
            "ufo"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "👾",
        description: "alien monster",
        category: "Smileys & Emotion",
        aliases: [
            "space_invader"
        ],
        tags: [
            "game",
            "retro"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🤖",
        description: "robot",
        category: "Smileys & Emotion",
        aliases: [
            "robot"
        ],
        tags: [],
        unicodeVersion: "8.0",
        iosVersion: "9.1"
    },
    {
        emoji: "😺",
        description: "grinning cat",
        category: "Smileys & Emotion",
        aliases: [
            "smiley_cat"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "😸",
        description: "grinning cat with smiling eyes",
        category: "Smileys & Emotion",
        aliases: [
            "smile_cat"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "😹",
        description: "cat with tears of joy",
        category: "Smileys & Emotion",
        aliases: [
            "joy_cat"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "😻",
        description: "smiling cat with heart-eyes",
        category: "Smileys & Emotion",
        aliases: [
            "heart_eyes_cat"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "😼",
        description: "cat with wry smile",
        category: "Smileys & Emotion",
        aliases: [
            "smirk_cat"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "😽",
        description: "kissing cat",
        category: "Smileys & Emotion",
        aliases: [
            "kissing_cat"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🙀",
        description: "weary cat",
        category: "Smileys & Emotion",
        aliases: [
            "scream_cat"
        ],
        tags: [
            "horror"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "😿",
        description: "crying cat",
        category: "Smileys & Emotion",
        aliases: [
            "crying_cat_face"
        ],
        tags: [
            "sad",
            "tear"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "😾",
        description: "pouting cat",
        category: "Smileys & Emotion",
        aliases: [
            "pouting_cat"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🙈",
        description: "see-no-evil monkey",
        category: "Smileys & Emotion",
        aliases: [
            "see_no_evil"
        ],
        tags: [
            "monkey",
            "blind",
            "ignore"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🙉",
        description: "hear-no-evil monkey",
        category: "Smileys & Emotion",
        aliases: [
            "hear_no_evil"
        ],
        tags: [
            "monkey",
            "deaf"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🙊",
        description: "speak-no-evil monkey",
        category: "Smileys & Emotion",
        aliases: [
            "speak_no_evil"
        ],
        tags: [
            "monkey",
            "mute",
            "hush"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💋",
        description: "kiss mark",
        category: "Smileys & Emotion",
        aliases: [
            "kiss"
        ],
        tags: [
            "lipstick"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💌",
        description: "love letter",
        category: "Smileys & Emotion",
        aliases: [
            "love_letter"
        ],
        tags: [
            "email",
            "envelope"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💘",
        description: "heart with arrow",
        category: "Smileys & Emotion",
        aliases: [
            "cupid"
        ],
        tags: [
            "love",
            "heart"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💝",
        description: "heart with ribbon",
        category: "Smileys & Emotion",
        aliases: [
            "gift_heart"
        ],
        tags: [
            "chocolates"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💖",
        description: "sparkling heart",
        category: "Smileys & Emotion",
        aliases: [
            "sparkling_heart"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💗",
        description: "growing heart",
        category: "Smileys & Emotion",
        aliases: [
            "heartpulse"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💓",
        description: "beating heart",
        category: "Smileys & Emotion",
        aliases: [
            "heartbeat"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💞",
        description: "revolving hearts",
        category: "Smileys & Emotion",
        aliases: [
            "revolving_hearts"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💕",
        description: "two hearts",
        category: "Smileys & Emotion",
        aliases: [
            "two_hearts"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💟",
        description: "heart decoration",
        category: "Smileys & Emotion",
        aliases: [
            "heart_decoration"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "❣️",
        description: "heart exclamation",
        category: "Smileys & Emotion",
        aliases: [
            "heavy_heart_exclamation"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "9.1"
    },
    {
        emoji: "💔",
        description: "broken heart",
        category: "Smileys & Emotion",
        aliases: [
            "broken_heart"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "❤️",
        description: "red heart",
        category: "Smileys & Emotion",
        aliases: [
            "heart"
        ],
        tags: [
            "love"
        ],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "🧡",
        description: "orange heart",
        category: "Smileys & Emotion",
        aliases: [
            "orange_heart"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "💛",
        description: "yellow heart",
        category: "Smileys & Emotion",
        aliases: [
            "yellow_heart"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💚",
        description: "green heart",
        category: "Smileys & Emotion",
        aliases: [
            "green_heart"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💙",
        description: "blue heart",
        category: "Smileys & Emotion",
        aliases: [
            "blue_heart"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💜",
        description: "purple heart",
        category: "Smileys & Emotion",
        aliases: [
            "purple_heart"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🤎",
        description: "brown heart",
        category: "Smileys & Emotion",
        aliases: [
            "brown_heart"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🖤",
        description: "black heart",
        category: "Smileys & Emotion",
        aliases: [
            "black_heart"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🤍",
        description: "white heart",
        category: "Smileys & Emotion",
        aliases: [
            "white_heart"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "💯",
        description: "hundred points",
        category: "Smileys & Emotion",
        aliases: [
            "100"
        ],
        tags: [
            "score",
            "perfect"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💢",
        description: "anger symbol",
        category: "Smileys & Emotion",
        aliases: [
            "anger"
        ],
        tags: [
            "angry"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💥",
        description: "collision",
        category: "Smileys & Emotion",
        aliases: [
            "boom",
            "collision"
        ],
        tags: [
            "explode"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💫",
        description: "dizzy",
        category: "Smileys & Emotion",
        aliases: [
            "dizzy"
        ],
        tags: [
            "star"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💦",
        description: "sweat droplets",
        category: "Smileys & Emotion",
        aliases: [
            "sweat_drops"
        ],
        tags: [
            "water",
            "workout"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💨",
        description: "dashing away",
        category: "Smileys & Emotion",
        aliases: [
            "dash"
        ],
        tags: [
            "wind",
            "blow",
            "fast"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🕳️",
        description: "hole",
        category: "Smileys & Emotion",
        aliases: [
            "hole"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "💣",
        description: "bomb",
        category: "Smileys & Emotion",
        aliases: [
            "bomb"
        ],
        tags: [
            "boom"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💬",
        description: "speech balloon",
        category: "Smileys & Emotion",
        aliases: [
            "speech_balloon"
        ],
        tags: [
            "comment"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "👁️‍🗨️",
        description: "eye in speech bubble",
        category: "Smileys & Emotion",
        aliases: [
            "eye_speech_bubble"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🗨️",
        description: "left speech bubble",
        category: "Smileys & Emotion",
        aliases: [
            "left_speech_bubble"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🗯️",
        description: "right anger bubble",
        category: "Smileys & Emotion",
        aliases: [
            "right_anger_bubble"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "💭",
        description: "thought balloon",
        category: "Smileys & Emotion",
        aliases: [
            "thought_balloon"
        ],
        tags: [
            "thinking"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💤",
        description: "zzz",
        category: "Smileys & Emotion",
        aliases: [
            "zzz"
        ],
        tags: [
            "sleeping"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "👋",
        description: "waving hand",
        category: "People & Body",
        aliases: [
            "wave"
        ],
        tags: [
            "goodbye"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "🤚",
        description: "raised back of hand",
        category: "People & Body",
        aliases: [
            "raised_back_of_hand"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "🖐️",
        description: "hand with fingers splayed",
        category: "People & Body",
        aliases: [
            "raised_hand_with_fingers_splayed"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1",
        skinTones: true
    },
    {
        emoji: "✋",
        description: "raised hand",
        category: "People & Body",
        aliases: [
            "hand",
            "raised_hand"
        ],
        tags: [
            "highfive",
            "stop"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "🖖",
        description: "vulcan salute",
        category: "People & Body",
        aliases: [
            "vulcan_salute"
        ],
        tags: [
            "prosper",
            "spock"
        ],
        unicodeVersion: "7.0",
        iosVersion: "8.3",
        skinTones: true
    },
    {
        emoji: "👌",
        description: "OK hand",
        category: "People & Body",
        aliases: [
            "ok_hand"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "🤌",
        description: "pinched fingers",
        category: "People & Body",
        aliases: [
            "pinched_fingers"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0",
        skinTones: true
    },
    {
        emoji: "🤏",
        description: "pinching hand",
        category: "People & Body",
        aliases: [
            "pinching_hand"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0",
        skinTones: true
    },
    {
        emoji: "✌️",
        description: "victory hand",
        category: "People & Body",
        aliases: [
            "v"
        ],
        tags: [
            "victory",
            "peace"
        ],
        unicodeVersion: "",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "🤞",
        description: "crossed fingers",
        category: "People & Body",
        aliases: [
            "crossed_fingers"
        ],
        tags: [
            "luck",
            "hopeful"
        ],
        unicodeVersion: "9.0",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "🤟",
        description: "love-you gesture",
        category: "People & Body",
        aliases: [
            "love_you_gesture"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🤘",
        description: "sign of the horns",
        category: "People & Body",
        aliases: [
            "metal"
        ],
        tags: [],
        unicodeVersion: "8.0",
        iosVersion: "9.1",
        skinTones: true
    },
    {
        emoji: "🤙",
        description: "call me hand",
        category: "People & Body",
        aliases: [
            "call_me_hand"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "👈",
        description: "backhand index pointing left",
        category: "People & Body",
        aliases: [
            "point_left"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "👉",
        description: "backhand index pointing right",
        category: "People & Body",
        aliases: [
            "point_right"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "👆",
        description: "backhand index pointing up",
        category: "People & Body",
        aliases: [
            "point_up_2"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "🖕",
        description: "middle finger",
        category: "People & Body",
        aliases: [
            "middle_finger",
            "fu"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1",
        skinTones: true
    },
    {
        emoji: "👇",
        description: "backhand index pointing down",
        category: "People & Body",
        aliases: [
            "point_down"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "☝️",
        description: "index pointing up",
        category: "People & Body",
        aliases: [
            "point_up"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "👍",
        description: "thumbs up",
        category: "People & Body",
        aliases: [
            "+1",
            "thumbsup"
        ],
        tags: [
            "approve",
            "ok"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "👎",
        description: "thumbs down",
        category: "People & Body",
        aliases: [
            "-1",
            "thumbsdown"
        ],
        tags: [
            "disapprove",
            "bury"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "✊",
        description: "raised fist",
        category: "People & Body",
        aliases: [
            "fist_raised",
            "fist"
        ],
        tags: [
            "power"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "👊",
        description: "oncoming fist",
        category: "People & Body",
        aliases: [
            "fist_oncoming",
            "facepunch",
            "punch"
        ],
        tags: [
            "attack"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "🤛",
        description: "left-facing fist",
        category: "People & Body",
        aliases: [
            "fist_left"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "🤜",
        description: "right-facing fist",
        category: "People & Body",
        aliases: [
            "fist_right"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "👏",
        description: "clapping hands",
        category: "People & Body",
        aliases: [
            "clap"
        ],
        tags: [
            "praise",
            "applause"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "🙌",
        description: "raising hands",
        category: "People & Body",
        aliases: [
            "raised_hands"
        ],
        tags: [
            "hooray"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "👐",
        description: "open hands",
        category: "People & Body",
        aliases: [
            "open_hands"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "🤲",
        description: "palms up together",
        category: "People & Body",
        aliases: [
            "palms_up_together"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🤝",
        description: "handshake",
        category: "People & Body",
        aliases: [
            "handshake"
        ],
        tags: [
            "deal"
        ],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🙏",
        description: "folded hands",
        category: "People & Body",
        aliases: [
            "pray"
        ],
        tags: [
            "please",
            "hope",
            "wish"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "✍️",
        description: "writing hand",
        category: "People & Body",
        aliases: [
            "writing_hand"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "9.1",
        skinTones: true
    },
    {
        emoji: "💅",
        description: "nail polish",
        category: "People & Body",
        aliases: [
            "nail_care"
        ],
        tags: [
            "beauty",
            "manicure"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "🤳",
        description: "selfie",
        category: "People & Body",
        aliases: [
            "selfie"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "💪",
        description: "flexed biceps",
        category: "People & Body",
        aliases: [
            "muscle"
        ],
        tags: [
            "flex",
            "bicep",
            "strong",
            "workout"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "🦾",
        description: "mechanical arm",
        category: "People & Body",
        aliases: [
            "mechanical_arm"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🦿",
        description: "mechanical leg",
        category: "People & Body",
        aliases: [
            "mechanical_leg"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🦵",
        description: "leg",
        category: "People & Body",
        aliases: [
            "leg"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🦶",
        description: "foot",
        category: "People & Body",
        aliases: [
            "foot"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "👂",
        description: "ear",
        category: "People & Body",
        aliases: [
            "ear"
        ],
        tags: [
            "hear",
            "sound",
            "listen"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "🦻",
        description: "ear with hearing aid",
        category: "People & Body",
        aliases: [
            "ear_with_hearing_aid"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0",
        skinTones: true
    },
    {
        emoji: "👃",
        description: "nose",
        category: "People & Body",
        aliases: [
            "nose"
        ],
        tags: [
            "smell"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "🧠",
        description: "brain",
        category: "People & Body",
        aliases: [
            "brain"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🫀",
        description: "anatomical heart",
        category: "People & Body",
        aliases: [
            "anatomical_heart"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🫁",
        description: "lungs",
        category: "People & Body",
        aliases: [
            "lungs"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🦷",
        description: "tooth",
        category: "People & Body",
        aliases: [
            "tooth"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🦴",
        description: "bone",
        category: "People & Body",
        aliases: [
            "bone"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "👀",
        description: "eyes",
        category: "People & Body",
        aliases: [
            "eyes"
        ],
        tags: [
            "look",
            "see",
            "watch"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "👁️",
        description: "eye",
        category: "People & Body",
        aliases: [
            "eye"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "👅",
        description: "tongue",
        category: "People & Body",
        aliases: [
            "tongue"
        ],
        tags: [
            "taste"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "👄",
        description: "mouth",
        category: "People & Body",
        aliases: [
            "lips"
        ],
        tags: [
            "kiss"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "👶",
        description: "baby",
        category: "People & Body",
        aliases: [
            "baby"
        ],
        tags: [
            "child",
            "newborn"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "🧒",
        description: "child",
        category: "People & Body",
        aliases: [
            "child"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "👦",
        description: "boy",
        category: "People & Body",
        aliases: [
            "boy"
        ],
        tags: [
            "child"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "👧",
        description: "girl",
        category: "People & Body",
        aliases: [
            "girl"
        ],
        tags: [
            "child"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "🧑",
        description: "person",
        category: "People & Body",
        aliases: [
            "adult"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "👱",
        description: "person: blond hair",
        category: "People & Body",
        aliases: [
            "blond_haired_person"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "👨",
        description: "man",
        category: "People & Body",
        aliases: [
            "man"
        ],
        tags: [
            "mustache",
            "father",
            "dad"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "🧔",
        description: "man: beard",
        category: "People & Body",
        aliases: [
            "bearded_person"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "👨‍🦰",
        description: "man: red hair",
        category: "People & Body",
        aliases: [
            "red_haired_man"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "👨‍🦱",
        description: "man: curly hair",
        category: "People & Body",
        aliases: [
            "curly_haired_man"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "👨‍🦳",
        description: "man: white hair",
        category: "People & Body",
        aliases: [
            "white_haired_man"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "👨‍🦲",
        description: "man: bald",
        category: "People & Body",
        aliases: [
            "bald_man"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "👩",
        description: "woman",
        category: "People & Body",
        aliases: [
            "woman"
        ],
        tags: [
            "girls"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "👩‍🦰",
        description: "woman: red hair",
        category: "People & Body",
        aliases: [
            "red_haired_woman"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🧑‍🦰",
        description: "person: red hair",
        category: "People & Body",
        aliases: [
            "person_red_hair"
        ],
        tags: [],
        unicodeVersion: "12.1",
        iosVersion: "13.2",
        skinTones: true
    },
    {
        emoji: "👩‍🦱",
        description: "woman: curly hair",
        category: "People & Body",
        aliases: [
            "curly_haired_woman"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🧑‍🦱",
        description: "person: curly hair",
        category: "People & Body",
        aliases: [
            "person_curly_hair"
        ],
        tags: [],
        unicodeVersion: "12.1",
        iosVersion: "13.2",
        skinTones: true
    },
    {
        emoji: "👩‍🦳",
        description: "woman: white hair",
        category: "People & Body",
        aliases: [
            "white_haired_woman"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🧑‍🦳",
        description: "person: white hair",
        category: "People & Body",
        aliases: [
            "person_white_hair"
        ],
        tags: [],
        unicodeVersion: "12.1",
        iosVersion: "13.2",
        skinTones: true
    },
    {
        emoji: "👩‍🦲",
        description: "woman: bald",
        category: "People & Body",
        aliases: [
            "bald_woman"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🧑‍🦲",
        description: "person: bald",
        category: "People & Body",
        aliases: [
            "person_bald"
        ],
        tags: [],
        unicodeVersion: "12.1",
        iosVersion: "13.2",
        skinTones: true
    },
    {
        emoji: "👱‍♀️",
        description: "woman: blond hair",
        category: "People & Body",
        aliases: [
            "blond_haired_woman",
            "blonde_woman"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "10.0",
        skinTones: true
    },
    {
        emoji: "👱‍♂️",
        description: "man: blond hair",
        category: "People & Body",
        aliases: [
            "blond_haired_man"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🧓",
        description: "older person",
        category: "People & Body",
        aliases: [
            "older_adult"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "👴",
        description: "old man",
        category: "People & Body",
        aliases: [
            "older_man"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "👵",
        description: "old woman",
        category: "People & Body",
        aliases: [
            "older_woman"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "🙍",
        description: "person frowning",
        category: "People & Body",
        aliases: [
            "frowning_person"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "🙍‍♂️",
        description: "man frowning",
        category: "People & Body",
        aliases: [
            "frowning_man"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "10.0",
        skinTones: true
    },
    {
        emoji: "🙍‍♀️",
        description: "woman frowning",
        category: "People & Body",
        aliases: [
            "frowning_woman"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🙎",
        description: "person pouting",
        category: "People & Body",
        aliases: [
            "pouting_face"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "🙎‍♂️",
        description: "man pouting",
        category: "People & Body",
        aliases: [
            "pouting_man"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "10.0",
        skinTones: true
    },
    {
        emoji: "🙎‍♀️",
        description: "woman pouting",
        category: "People & Body",
        aliases: [
            "pouting_woman"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🙅",
        description: "person gesturing NO",
        category: "People & Body",
        aliases: [
            "no_good"
        ],
        tags: [
            "stop",
            "halt",
            "denied"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "🙅‍♂️",
        description: "man gesturing NO",
        category: "People & Body",
        aliases: [
            "no_good_man",
            "ng_man"
        ],
        tags: [
            "stop",
            "halt",
            "denied"
        ],
        unicodeVersion: "6.0",
        iosVersion: "10.0",
        skinTones: true
    },
    {
        emoji: "🙅‍♀️",
        description: "woman gesturing NO",
        category: "People & Body",
        aliases: [
            "no_good_woman",
            "ng_woman"
        ],
        tags: [
            "stop",
            "halt",
            "denied"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🙆",
        description: "person gesturing OK",
        category: "People & Body",
        aliases: [
            "ok_person"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "🙆‍♂️",
        description: "man gesturing OK",
        category: "People & Body",
        aliases: [
            "ok_man"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "10.0",
        skinTones: true
    },
    {
        emoji: "🙆‍♀️",
        description: "woman gesturing OK",
        category: "People & Body",
        aliases: [
            "ok_woman"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "💁",
        description: "person tipping hand",
        category: "People & Body",
        aliases: [
            "tipping_hand_person",
            "information_desk_person"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "💁‍♂️",
        description: "man tipping hand",
        category: "People & Body",
        aliases: [
            "tipping_hand_man",
            "sassy_man"
        ],
        tags: [
            "information"
        ],
        unicodeVersion: "6.0",
        iosVersion: "10.0",
        skinTones: true
    },
    {
        emoji: "💁‍♀️",
        description: "woman tipping hand",
        category: "People & Body",
        aliases: [
            "tipping_hand_woman",
            "sassy_woman"
        ],
        tags: [
            "information"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🙋",
        description: "person raising hand",
        category: "People & Body",
        aliases: [
            "raising_hand"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "🙋‍♂️",
        description: "man raising hand",
        category: "People & Body",
        aliases: [
            "raising_hand_man"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "10.0",
        skinTones: true
    },
    {
        emoji: "🙋‍♀️",
        description: "woman raising hand",
        category: "People & Body",
        aliases: [
            "raising_hand_woman"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🧏",
        description: "deaf person",
        category: "People & Body",
        aliases: [
            "deaf_person"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0",
        skinTones: true
    },
    {
        emoji: "🧏‍♂️",
        description: "deaf man",
        category: "People & Body",
        aliases: [
            "deaf_man"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0",
        skinTones: true
    },
    {
        emoji: "🧏‍♀️",
        description: "deaf woman",
        category: "People & Body",
        aliases: [
            "deaf_woman"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0",
        skinTones: true
    },
    {
        emoji: "🙇",
        description: "person bowing",
        category: "People & Body",
        aliases: [
            "bow"
        ],
        tags: [
            "respect",
            "thanks"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "🙇‍♂️",
        description: "man bowing",
        category: "People & Body",
        aliases: [
            "bowing_man"
        ],
        tags: [
            "respect",
            "thanks"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🙇‍♀️",
        description: "woman bowing",
        category: "People & Body",
        aliases: [
            "bowing_woman"
        ],
        tags: [
            "respect",
            "thanks"
        ],
        unicodeVersion: "6.0",
        iosVersion: "10.0",
        skinTones: true
    },
    {
        emoji: "🤦",
        description: "person facepalming",
        category: "People & Body",
        aliases: [
            "facepalm"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🤦‍♂️",
        description: "man facepalming",
        category: "People & Body",
        aliases: [
            "man_facepalming"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "🤦‍♀️",
        description: "woman facepalming",
        category: "People & Body",
        aliases: [
            "woman_facepalming"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "🤷",
        description: "person shrugging",
        category: "People & Body",
        aliases: [
            "shrug"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🤷‍♂️",
        description: "man shrugging",
        category: "People & Body",
        aliases: [
            "man_shrugging"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "🤷‍♀️",
        description: "woman shrugging",
        category: "People & Body",
        aliases: [
            "woman_shrugging"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "🧑‍⚕️",
        description: "health worker",
        category: "People & Body",
        aliases: [
            "health_worker"
        ],
        tags: [],
        unicodeVersion: "12.1",
        iosVersion: "13.2",
        skinTones: true
    },
    {
        emoji: "👨‍⚕️",
        description: "man health worker",
        category: "People & Body",
        aliases: [
            "man_health_worker"
        ],
        tags: [
            "doctor",
            "nurse"
        ],
        unicodeVersion: "",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "👩‍⚕️",
        description: "woman health worker",
        category: "People & Body",
        aliases: [
            "woman_health_worker"
        ],
        tags: [
            "doctor",
            "nurse"
        ],
        unicodeVersion: "",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "🧑‍🎓",
        description: "student",
        category: "People & Body",
        aliases: [
            "student"
        ],
        tags: [],
        unicodeVersion: "12.1",
        iosVersion: "13.2",
        skinTones: true
    },
    {
        emoji: "👨‍🎓",
        description: "man student",
        category: "People & Body",
        aliases: [
            "man_student"
        ],
        tags: [
            "graduation"
        ],
        unicodeVersion: "",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "👩‍🎓",
        description: "woman student",
        category: "People & Body",
        aliases: [
            "woman_student"
        ],
        tags: [
            "graduation"
        ],
        unicodeVersion: "",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "🧑‍🏫",
        description: "teacher",
        category: "People & Body",
        aliases: [
            "teacher"
        ],
        tags: [],
        unicodeVersion: "12.1",
        iosVersion: "13.2",
        skinTones: true
    },
    {
        emoji: "👨‍🏫",
        description: "man teacher",
        category: "People & Body",
        aliases: [
            "man_teacher"
        ],
        tags: [
            "school",
            "professor"
        ],
        unicodeVersion: "",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "👩‍🏫",
        description: "woman teacher",
        category: "People & Body",
        aliases: [
            "woman_teacher"
        ],
        tags: [
            "school",
            "professor"
        ],
        unicodeVersion: "",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "🧑‍⚖️",
        description: "judge",
        category: "People & Body",
        aliases: [
            "judge"
        ],
        tags: [],
        unicodeVersion: "12.1",
        iosVersion: "13.2",
        skinTones: true
    },
    {
        emoji: "👨‍⚖️",
        description: "man judge",
        category: "People & Body",
        aliases: [
            "man_judge"
        ],
        tags: [
            "justice"
        ],
        unicodeVersion: "",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "👩‍⚖️",
        description: "woman judge",
        category: "People & Body",
        aliases: [
            "woman_judge"
        ],
        tags: [
            "justice"
        ],
        unicodeVersion: "",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "🧑‍🌾",
        description: "farmer",
        category: "People & Body",
        aliases: [
            "farmer"
        ],
        tags: [],
        unicodeVersion: "12.1",
        iosVersion: "13.2",
        skinTones: true
    },
    {
        emoji: "👨‍🌾",
        description: "man farmer",
        category: "People & Body",
        aliases: [
            "man_farmer"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "👩‍🌾",
        description: "woman farmer",
        category: "People & Body",
        aliases: [
            "woman_farmer"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "🧑‍🍳",
        description: "cook",
        category: "People & Body",
        aliases: [
            "cook"
        ],
        tags: [],
        unicodeVersion: "12.1",
        iosVersion: "13.2",
        skinTones: true
    },
    {
        emoji: "👨‍🍳",
        description: "man cook",
        category: "People & Body",
        aliases: [
            "man_cook"
        ],
        tags: [
            "chef"
        ],
        unicodeVersion: "",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "👩‍🍳",
        description: "woman cook",
        category: "People & Body",
        aliases: [
            "woman_cook"
        ],
        tags: [
            "chef"
        ],
        unicodeVersion: "",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "🧑‍🔧",
        description: "mechanic",
        category: "People & Body",
        aliases: [
            "mechanic"
        ],
        tags: [],
        unicodeVersion: "12.1",
        iosVersion: "13.2",
        skinTones: true
    },
    {
        emoji: "👨‍🔧",
        description: "man mechanic",
        category: "People & Body",
        aliases: [
            "man_mechanic"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "👩‍🔧",
        description: "woman mechanic",
        category: "People & Body",
        aliases: [
            "woman_mechanic"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "🧑‍🏭",
        description: "factory worker",
        category: "People & Body",
        aliases: [
            "factory_worker"
        ],
        tags: [],
        unicodeVersion: "12.1",
        iosVersion: "13.2",
        skinTones: true
    },
    {
        emoji: "👨‍🏭",
        description: "man factory worker",
        category: "People & Body",
        aliases: [
            "man_factory_worker"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "👩‍🏭",
        description: "woman factory worker",
        category: "People & Body",
        aliases: [
            "woman_factory_worker"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "🧑‍💼",
        description: "office worker",
        category: "People & Body",
        aliases: [
            "office_worker"
        ],
        tags: [],
        unicodeVersion: "12.1",
        iosVersion: "13.2",
        skinTones: true
    },
    {
        emoji: "👨‍💼",
        description: "man office worker",
        category: "People & Body",
        aliases: [
            "man_office_worker"
        ],
        tags: [
            "business"
        ],
        unicodeVersion: "",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "👩‍💼",
        description: "woman office worker",
        category: "People & Body",
        aliases: [
            "woman_office_worker"
        ],
        tags: [
            "business"
        ],
        unicodeVersion: "",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "🧑‍🔬",
        description: "scientist",
        category: "People & Body",
        aliases: [
            "scientist"
        ],
        tags: [],
        unicodeVersion: "12.1",
        iosVersion: "13.2",
        skinTones: true
    },
    {
        emoji: "👨‍🔬",
        description: "man scientist",
        category: "People & Body",
        aliases: [
            "man_scientist"
        ],
        tags: [
            "research"
        ],
        unicodeVersion: "",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "👩‍🔬",
        description: "woman scientist",
        category: "People & Body",
        aliases: [
            "woman_scientist"
        ],
        tags: [
            "research"
        ],
        unicodeVersion: "",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "🧑‍💻",
        description: "technologist",
        category: "People & Body",
        aliases: [
            "technologist"
        ],
        tags: [],
        unicodeVersion: "12.1",
        iosVersion: "13.2",
        skinTones: true
    },
    {
        emoji: "👨‍💻",
        description: "man technologist",
        category: "People & Body",
        aliases: [
            "man_technologist"
        ],
        tags: [
            "coder"
        ],
        unicodeVersion: "",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "👩‍💻",
        description: "woman technologist",
        category: "People & Body",
        aliases: [
            "woman_technologist"
        ],
        tags: [
            "coder"
        ],
        unicodeVersion: "",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "🧑‍🎤",
        description: "singer",
        category: "People & Body",
        aliases: [
            "singer"
        ],
        tags: [],
        unicodeVersion: "12.1",
        iosVersion: "13.2",
        skinTones: true
    },
    {
        emoji: "👨‍🎤",
        description: "man singer",
        category: "People & Body",
        aliases: [
            "man_singer"
        ],
        tags: [
            "rockstar"
        ],
        unicodeVersion: "",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "👩‍🎤",
        description: "woman singer",
        category: "People & Body",
        aliases: [
            "woman_singer"
        ],
        tags: [
            "rockstar"
        ],
        unicodeVersion: "",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "🧑‍🎨",
        description: "artist",
        category: "People & Body",
        aliases: [
            "artist"
        ],
        tags: [],
        unicodeVersion: "12.1",
        iosVersion: "13.2",
        skinTones: true
    },
    {
        emoji: "👨‍🎨",
        description: "man artist",
        category: "People & Body",
        aliases: [
            "man_artist"
        ],
        tags: [
            "painter"
        ],
        unicodeVersion: "",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "👩‍🎨",
        description: "woman artist",
        category: "People & Body",
        aliases: [
            "woman_artist"
        ],
        tags: [
            "painter"
        ],
        unicodeVersion: "",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "🧑‍✈️",
        description: "pilot",
        category: "People & Body",
        aliases: [
            "pilot"
        ],
        tags: [],
        unicodeVersion: "12.1",
        iosVersion: "13.2",
        skinTones: true
    },
    {
        emoji: "👨‍✈️",
        description: "man pilot",
        category: "People & Body",
        aliases: [
            "man_pilot"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "👩‍✈️",
        description: "woman pilot",
        category: "People & Body",
        aliases: [
            "woman_pilot"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "🧑‍🚀",
        description: "astronaut",
        category: "People & Body",
        aliases: [
            "astronaut"
        ],
        tags: [],
        unicodeVersion: "12.1",
        iosVersion: "13.2",
        skinTones: true
    },
    {
        emoji: "👨‍🚀",
        description: "man astronaut",
        category: "People & Body",
        aliases: [
            "man_astronaut"
        ],
        tags: [
            "space"
        ],
        unicodeVersion: "",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "👩‍🚀",
        description: "woman astronaut",
        category: "People & Body",
        aliases: [
            "woman_astronaut"
        ],
        tags: [
            "space"
        ],
        unicodeVersion: "",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "🧑‍🚒",
        description: "firefighter",
        category: "People & Body",
        aliases: [
            "firefighter"
        ],
        tags: [],
        unicodeVersion: "12.1",
        iosVersion: "13.2",
        skinTones: true
    },
    {
        emoji: "👨‍🚒",
        description: "man firefighter",
        category: "People & Body",
        aliases: [
            "man_firefighter"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "👩‍🚒",
        description: "woman firefighter",
        category: "People & Body",
        aliases: [
            "woman_firefighter"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "👮",
        description: "police officer",
        category: "People & Body",
        aliases: [
            "police_officer",
            "cop"
        ],
        tags: [
            "law"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "👮‍♂️",
        description: "man police officer",
        category: "People & Body",
        aliases: [
            "policeman"
        ],
        tags: [
            "law",
            "cop"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "👮‍♀️",
        description: "woman police officer",
        category: "People & Body",
        aliases: [
            "policewoman"
        ],
        tags: [
            "law",
            "cop"
        ],
        unicodeVersion: "6.0",
        iosVersion: "10.0",
        skinTones: true
    },
    {
        emoji: "🕵️",
        description: "detective",
        category: "People & Body",
        aliases: [
            "detective"
        ],
        tags: [
            "sleuth"
        ],
        unicodeVersion: "7.0",
        iosVersion: "9.1",
        skinTones: true
    },
    {
        emoji: "🕵️‍♂️",
        description: "man detective",
        category: "People & Body",
        aliases: [
            "male_detective"
        ],
        tags: [
            "sleuth"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🕵️‍♀️",
        description: "woman detective",
        category: "People & Body",
        aliases: [
            "female_detective"
        ],
        tags: [
            "sleuth"
        ],
        unicodeVersion: "6.0",
        iosVersion: "10.0",
        skinTones: true
    },
    {
        emoji: "💂",
        description: "guard",
        category: "People & Body",
        aliases: [
            "guard"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "💂‍♂️",
        description: "man guard",
        category: "People & Body",
        aliases: [
            "guardsman"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "💂‍♀️",
        description: "woman guard",
        category: "People & Body",
        aliases: [
            "guardswoman"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "10.0",
        skinTones: true
    },
    {
        emoji: "🥷",
        description: "ninja",
        category: "People & Body",
        aliases: [
            "ninja"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0",
        skinTones: true
    },
    {
        emoji: "👷",
        description: "construction worker",
        category: "People & Body",
        aliases: [
            "construction_worker"
        ],
        tags: [
            "helmet"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "👷‍♂️",
        description: "man construction worker",
        category: "People & Body",
        aliases: [
            "construction_worker_man"
        ],
        tags: [
            "helmet"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "👷‍♀️",
        description: "woman construction worker",
        category: "People & Body",
        aliases: [
            "construction_worker_woman"
        ],
        tags: [
            "helmet"
        ],
        unicodeVersion: "6.0",
        iosVersion: "10.0",
        skinTones: true
    },
    {
        emoji: "🤴",
        description: "prince",
        category: "People & Body",
        aliases: [
            "prince"
        ],
        tags: [
            "crown",
            "royal"
        ],
        unicodeVersion: "9.0",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "👸",
        description: "princess",
        category: "People & Body",
        aliases: [
            "princess"
        ],
        tags: [
            "crown",
            "royal"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "👳",
        description: "person wearing turban",
        category: "People & Body",
        aliases: [
            "person_with_turban"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "👳‍♂️",
        description: "man wearing turban",
        category: "People & Body",
        aliases: [
            "man_with_turban"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "👳‍♀️",
        description: "woman wearing turban",
        category: "People & Body",
        aliases: [
            "woman_with_turban"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "10.0",
        skinTones: true
    },
    {
        emoji: "👲",
        description: "person with skullcap",
        category: "People & Body",
        aliases: [
            "man_with_gua_pi_mao"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "🧕",
        description: "woman with headscarf",
        category: "People & Body",
        aliases: [
            "woman_with_headscarf"
        ],
        tags: [
            "hijab"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🤵",
        description: "person in tuxedo",
        category: "People & Body",
        aliases: [
            "person_in_tuxedo"
        ],
        tags: [
            "groom",
            "marriage",
            "wedding"
        ],
        unicodeVersion: "9.0",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "🤵‍♂️",
        description: "man in tuxedo",
        category: "People & Body",
        aliases: [
            "man_in_tuxedo"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0",
        skinTones: true
    },
    {
        emoji: "🤵‍♀️",
        description: "woman in tuxedo",
        category: "People & Body",
        aliases: [
            "woman_in_tuxedo"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0",
        skinTones: true
    },
    {
        emoji: "👰",
        description: "person with veil",
        category: "People & Body",
        aliases: [
            "person_with_veil"
        ],
        tags: [
            "marriage",
            "wedding"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "👰‍♂️",
        description: "man with veil",
        category: "People & Body",
        aliases: [
            "man_with_veil"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0",
        skinTones: true
    },
    {
        emoji: "👰‍♀️",
        description: "woman with veil",
        category: "People & Body",
        aliases: [
            "woman_with_veil",
            "bride_with_veil"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0",
        skinTones: true
    },
    {
        emoji: "🤰",
        description: "pregnant woman",
        category: "People & Body",
        aliases: [
            "pregnant_woman"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "🤱",
        description: "breast-feeding",
        category: "People & Body",
        aliases: [
            "breast_feeding"
        ],
        tags: [
            "nursing"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "👩‍🍼",
        description: "woman feeding baby",
        category: "People & Body",
        aliases: [
            "woman_feeding_baby"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0",
        skinTones: true
    },
    {
        emoji: "👨‍🍼",
        description: "man feeding baby",
        category: "People & Body",
        aliases: [
            "man_feeding_baby"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0",
        skinTones: true
    },
    {
        emoji: "🧑‍🍼",
        description: "person feeding baby",
        category: "People & Body",
        aliases: [
            "person_feeding_baby"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0",
        skinTones: true
    },
    {
        emoji: "👼",
        description: "baby angel",
        category: "People & Body",
        aliases: [
            "angel"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "🎅",
        description: "Santa Claus",
        category: "People & Body",
        aliases: [
            "santa"
        ],
        tags: [
            "christmas"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "🤶",
        description: "Mrs. Claus",
        category: "People & Body",
        aliases: [
            "mrs_claus"
        ],
        tags: [
            "santa"
        ],
        unicodeVersion: "9.0",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "🧑‍🎄",
        description: "mx claus",
        category: "People & Body",
        aliases: [
            "mx_claus"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0",
        skinTones: true
    },
    {
        emoji: "🦸",
        description: "superhero",
        category: "People & Body",
        aliases: [
            "superhero"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🦸‍♂️",
        description: "man superhero",
        category: "People & Body",
        aliases: [
            "superhero_man"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🦸‍♀️",
        description: "woman superhero",
        category: "People & Body",
        aliases: [
            "superhero_woman"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🦹",
        description: "supervillain",
        category: "People & Body",
        aliases: [
            "supervillain"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🦹‍♂️",
        description: "man supervillain",
        category: "People & Body",
        aliases: [
            "supervillain_man"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🦹‍♀️",
        description: "woman supervillain",
        category: "People & Body",
        aliases: [
            "supervillain_woman"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🧙",
        description: "mage",
        category: "People & Body",
        aliases: [
            "mage"
        ],
        tags: [
            "wizard"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🧙‍♂️",
        description: "man mage",
        category: "People & Body",
        aliases: [
            "mage_man"
        ],
        tags: [
            "wizard"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🧙‍♀️",
        description: "woman mage",
        category: "People & Body",
        aliases: [
            "mage_woman"
        ],
        tags: [
            "wizard"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🧚",
        description: "fairy",
        category: "People & Body",
        aliases: [
            "fairy"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🧚‍♂️",
        description: "man fairy",
        category: "People & Body",
        aliases: [
            "fairy_man"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🧚‍♀️",
        description: "woman fairy",
        category: "People & Body",
        aliases: [
            "fairy_woman"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🧛",
        description: "vampire",
        category: "People & Body",
        aliases: [
            "vampire"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🧛‍♂️",
        description: "man vampire",
        category: "People & Body",
        aliases: [
            "vampire_man"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🧛‍♀️",
        description: "woman vampire",
        category: "People & Body",
        aliases: [
            "vampire_woman"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🧜",
        description: "merperson",
        category: "People & Body",
        aliases: [
            "merperson"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🧜‍♂️",
        description: "merman",
        category: "People & Body",
        aliases: [
            "merman"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🧜‍♀️",
        description: "mermaid",
        category: "People & Body",
        aliases: [
            "mermaid"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🧝",
        description: "elf",
        category: "People & Body",
        aliases: [
            "elf"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🧝‍♂️",
        description: "man elf",
        category: "People & Body",
        aliases: [
            "elf_man"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🧝‍♀️",
        description: "woman elf",
        category: "People & Body",
        aliases: [
            "elf_woman"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🧞",
        description: "genie",
        category: "People & Body",
        aliases: [
            "genie"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🧞‍♂️",
        description: "man genie",
        category: "People & Body",
        aliases: [
            "genie_man"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🧞‍♀️",
        description: "woman genie",
        category: "People & Body",
        aliases: [
            "genie_woman"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🧟",
        description: "zombie",
        category: "People & Body",
        aliases: [
            "zombie"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🧟‍♂️",
        description: "man zombie",
        category: "People & Body",
        aliases: [
            "zombie_man"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🧟‍♀️",
        description: "woman zombie",
        category: "People & Body",
        aliases: [
            "zombie_woman"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "💆",
        description: "person getting massage",
        category: "People & Body",
        aliases: [
            "massage"
        ],
        tags: [
            "spa"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "💆‍♂️",
        description: "man getting massage",
        category: "People & Body",
        aliases: [
            "massage_man"
        ],
        tags: [
            "spa"
        ],
        unicodeVersion: "6.0",
        iosVersion: "10.0",
        skinTones: true
    },
    {
        emoji: "💆‍♀️",
        description: "woman getting massage",
        category: "People & Body",
        aliases: [
            "massage_woman"
        ],
        tags: [
            "spa"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "💇",
        description: "person getting haircut",
        category: "People & Body",
        aliases: [
            "haircut"
        ],
        tags: [
            "beauty"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "💇‍♂️",
        description: "man getting haircut",
        category: "People & Body",
        aliases: [
            "haircut_man"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "10.0",
        skinTones: true
    },
    {
        emoji: "💇‍♀️",
        description: "woman getting haircut",
        category: "People & Body",
        aliases: [
            "haircut_woman"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🚶",
        description: "person walking",
        category: "People & Body",
        aliases: [
            "walking"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "🚶‍♂️",
        description: "man walking",
        category: "People & Body",
        aliases: [
            "walking_man"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🚶‍♀️",
        description: "woman walking",
        category: "People & Body",
        aliases: [
            "walking_woman"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "10.0",
        skinTones: true
    },
    {
        emoji: "🧍",
        description: "person standing",
        category: "People & Body",
        aliases: [
            "standing_person"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0",
        skinTones: true
    },
    {
        emoji: "🧍‍♂️",
        description: "man standing",
        category: "People & Body",
        aliases: [
            "standing_man"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0",
        skinTones: true
    },
    {
        emoji: "🧍‍♀️",
        description: "woman standing",
        category: "People & Body",
        aliases: [
            "standing_woman"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0",
        skinTones: true
    },
    {
        emoji: "🧎",
        description: "person kneeling",
        category: "People & Body",
        aliases: [
            "kneeling_person"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0",
        skinTones: true
    },
    {
        emoji: "🧎‍♂️",
        description: "man kneeling",
        category: "People & Body",
        aliases: [
            "kneeling_man"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0",
        skinTones: true
    },
    {
        emoji: "🧎‍♀️",
        description: "woman kneeling",
        category: "People & Body",
        aliases: [
            "kneeling_woman"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0",
        skinTones: true
    },
    {
        emoji: "🧑‍🦯",
        description: "person with white cane",
        category: "People & Body",
        aliases: [
            "person_with_probing_cane"
        ],
        tags: [],
        unicodeVersion: "12.1",
        iosVersion: "13.2",
        skinTones: true
    },
    {
        emoji: "👨‍🦯",
        description: "man with white cane",
        category: "People & Body",
        aliases: [
            "man_with_probing_cane"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0",
        skinTones: true
    },
    {
        emoji: "👩‍🦯",
        description: "woman with white cane",
        category: "People & Body",
        aliases: [
            "woman_with_probing_cane"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0",
        skinTones: true
    },
    {
        emoji: "🧑‍🦼",
        description: "person in motorized wheelchair",
        category: "People & Body",
        aliases: [
            "person_in_motorized_wheelchair"
        ],
        tags: [],
        unicodeVersion: "12.1",
        iosVersion: "13.2",
        skinTones: true
    },
    {
        emoji: "👨‍🦼",
        description: "man in motorized wheelchair",
        category: "People & Body",
        aliases: [
            "man_in_motorized_wheelchair"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0",
        skinTones: true
    },
    {
        emoji: "👩‍🦼",
        description: "woman in motorized wheelchair",
        category: "People & Body",
        aliases: [
            "woman_in_motorized_wheelchair"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0",
        skinTones: true
    },
    {
        emoji: "🧑‍🦽",
        description: "person in manual wheelchair",
        category: "People & Body",
        aliases: [
            "person_in_manual_wheelchair"
        ],
        tags: [],
        unicodeVersion: "12.1",
        iosVersion: "13.2",
        skinTones: true
    },
    {
        emoji: "👨‍🦽",
        description: "man in manual wheelchair",
        category: "People & Body",
        aliases: [
            "man_in_manual_wheelchair"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0",
        skinTones: true
    },
    {
        emoji: "👩‍🦽",
        description: "woman in manual wheelchair",
        category: "People & Body",
        aliases: [
            "woman_in_manual_wheelchair"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0",
        skinTones: true
    },
    {
        emoji: "🏃",
        description: "person running",
        category: "People & Body",
        aliases: [
            "runner",
            "running"
        ],
        tags: [
            "exercise",
            "workout",
            "marathon"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "🏃‍♂️",
        description: "man running",
        category: "People & Body",
        aliases: [
            "running_man"
        ],
        tags: [
            "exercise",
            "workout",
            "marathon"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🏃‍♀️",
        description: "woman running",
        category: "People & Body",
        aliases: [
            "running_woman"
        ],
        tags: [
            "exercise",
            "workout",
            "marathon"
        ],
        unicodeVersion: "6.0",
        iosVersion: "10.0",
        skinTones: true
    },
    {
        emoji: "💃",
        description: "woman dancing",
        category: "People & Body",
        aliases: [
            "woman_dancing",
            "dancer"
        ],
        tags: [
            "dress"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "🕺",
        description: "man dancing",
        category: "People & Body",
        aliases: [
            "man_dancing"
        ],
        tags: [
            "dancer"
        ],
        unicodeVersion: "9.0",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "🕴️",
        description: "person in suit levitating",
        category: "People & Body",
        aliases: [
            "business_suit_levitating"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1",
        skinTones: true
    },
    {
        emoji: "👯",
        description: "people with bunny ears",
        category: "People & Body",
        aliases: [
            "dancers"
        ],
        tags: [
            "bunny"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "👯‍♂️",
        description: "men with bunny ears",
        category: "People & Body",
        aliases: [
            "dancing_men"
        ],
        tags: [
            "bunny"
        ],
        unicodeVersion: "6.0",
        iosVersion: "10.0"
    },
    {
        emoji: "👯‍♀️",
        description: "women with bunny ears",
        category: "People & Body",
        aliases: [
            "dancing_women"
        ],
        tags: [
            "bunny"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🧖",
        description: "person in steamy room",
        category: "People & Body",
        aliases: [
            "sauna_person"
        ],
        tags: [
            "steamy"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🧖‍♂️",
        description: "man in steamy room",
        category: "People & Body",
        aliases: [
            "sauna_man"
        ],
        tags: [
            "steamy"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🧖‍♀️",
        description: "woman in steamy room",
        category: "People & Body",
        aliases: [
            "sauna_woman"
        ],
        tags: [
            "steamy"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🧗",
        description: "person climbing",
        category: "People & Body",
        aliases: [
            "climbing"
        ],
        tags: [
            "bouldering"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🧗‍♂️",
        description: "man climbing",
        category: "People & Body",
        aliases: [
            "climbing_man"
        ],
        tags: [
            "bouldering"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🧗‍♀️",
        description: "woman climbing",
        category: "People & Body",
        aliases: [
            "climbing_woman"
        ],
        tags: [
            "bouldering"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🤺",
        description: "person fencing",
        category: "People & Body",
        aliases: [
            "person_fencing"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🏇",
        description: "horse racing",
        category: "People & Body",
        aliases: [
            "horse_racing"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "⛷️",
        description: "skier",
        category: "People & Body",
        aliases: [
            "skier"
        ],
        tags: [],
        unicodeVersion: "5.2",
        iosVersion: "9.1"
    },
    {
        emoji: "🏂",
        description: "snowboarder",
        category: "People & Body",
        aliases: [
            "snowboarder"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "🏌️",
        description: "person golfing",
        category: "People & Body",
        aliases: [
            "golfing"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1",
        skinTones: true
    },
    {
        emoji: "🏌️‍♂️",
        description: "man golfing",
        category: "People & Body",
        aliases: [
            "golfing_man"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🏌️‍♀️",
        description: "woman golfing",
        category: "People & Body",
        aliases: [
            "golfing_woman"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "10.0",
        skinTones: true
    },
    {
        emoji: "🏄",
        description: "person surfing",
        category: "People & Body",
        aliases: [
            "surfer"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "🏄‍♂️",
        description: "man surfing",
        category: "People & Body",
        aliases: [
            "surfing_man"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🏄‍♀️",
        description: "woman surfing",
        category: "People & Body",
        aliases: [
            "surfing_woman"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "10.0",
        skinTones: true
    },
    {
        emoji: "🚣",
        description: "person rowing boat",
        category: "People & Body",
        aliases: [
            "rowboat"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "🚣‍♂️",
        description: "man rowing boat",
        category: "People & Body",
        aliases: [
            "rowing_man"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🚣‍♀️",
        description: "woman rowing boat",
        category: "People & Body",
        aliases: [
            "rowing_woman"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "10.0",
        skinTones: true
    },
    {
        emoji: "🏊",
        description: "person swimming",
        category: "People & Body",
        aliases: [
            "swimmer"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "🏊‍♂️",
        description: "man swimming",
        category: "People & Body",
        aliases: [
            "swimming_man"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🏊‍♀️",
        description: "woman swimming",
        category: "People & Body",
        aliases: [
            "swimming_woman"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "10.0",
        skinTones: true
    },
    {
        emoji: "⛹️",
        description: "person bouncing ball",
        category: "People & Body",
        aliases: [
            "bouncing_ball_person"
        ],
        tags: [
            "basketball"
        ],
        unicodeVersion: "5.2",
        iosVersion: "9.1",
        skinTones: true
    },
    {
        emoji: "⛹️‍♂️",
        description: "man bouncing ball",
        category: "People & Body",
        aliases: [
            "bouncing_ball_man",
            "basketball_man"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "⛹️‍♀️",
        description: "woman bouncing ball",
        category: "People & Body",
        aliases: [
            "bouncing_ball_woman",
            "basketball_woman"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "10.0",
        skinTones: true
    },
    {
        emoji: "🏋️",
        description: "person lifting weights",
        category: "People & Body",
        aliases: [
            "weight_lifting"
        ],
        tags: [
            "gym",
            "workout"
        ],
        unicodeVersion: "7.0",
        iosVersion: "9.1",
        skinTones: true
    },
    {
        emoji: "🏋️‍♂️",
        description: "man lifting weights",
        category: "People & Body",
        aliases: [
            "weight_lifting_man"
        ],
        tags: [
            "gym",
            "workout"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🏋️‍♀️",
        description: "woman lifting weights",
        category: "People & Body",
        aliases: [
            "weight_lifting_woman"
        ],
        tags: [
            "gym",
            "workout"
        ],
        unicodeVersion: "6.0",
        iosVersion: "10.0",
        skinTones: true
    },
    {
        emoji: "🚴",
        description: "person biking",
        category: "People & Body",
        aliases: [
            "bicyclist"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "🚴‍♂️",
        description: "man biking",
        category: "People & Body",
        aliases: [
            "biking_man"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🚴‍♀️",
        description: "woman biking",
        category: "People & Body",
        aliases: [
            "biking_woman"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "10.0",
        skinTones: true
    },
    {
        emoji: "🚵",
        description: "person mountain biking",
        category: "People & Body",
        aliases: [
            "mountain_bicyclist"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "🚵‍♂️",
        description: "man mountain biking",
        category: "People & Body",
        aliases: [
            "mountain_biking_man"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🚵‍♀️",
        description: "woman mountain biking",
        category: "People & Body",
        aliases: [
            "mountain_biking_woman"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "10.0",
        skinTones: true
    },
    {
        emoji: "🤸",
        description: "person cartwheeling",
        category: "People & Body",
        aliases: [
            "cartwheeling"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🤸‍♂️",
        description: "man cartwheeling",
        category: "People & Body",
        aliases: [
            "man_cartwheeling"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "🤸‍♀️",
        description: "woman cartwheeling",
        category: "People & Body",
        aliases: [
            "woman_cartwheeling"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "🤼",
        description: "people wrestling",
        category: "People & Body",
        aliases: [
            "wrestling"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🤼‍♂️",
        description: "men wrestling",
        category: "People & Body",
        aliases: [
            "men_wrestling"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🤼‍♀️",
        description: "women wrestling",
        category: "People & Body",
        aliases: [
            "women_wrestling"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🤽",
        description: "person playing water polo",
        category: "People & Body",
        aliases: [
            "water_polo"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🤽‍♂️",
        description: "man playing water polo",
        category: "People & Body",
        aliases: [
            "man_playing_water_polo"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "🤽‍♀️",
        description: "woman playing water polo",
        category: "People & Body",
        aliases: [
            "woman_playing_water_polo"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "🤾",
        description: "person playing handball",
        category: "People & Body",
        aliases: [
            "handball_person"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🤾‍♂️",
        description: "man playing handball",
        category: "People & Body",
        aliases: [
            "man_playing_handball"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "🤾‍♀️",
        description: "woman playing handball",
        category: "People & Body",
        aliases: [
            "woman_playing_handball"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "🤹",
        description: "person juggling",
        category: "People & Body",
        aliases: [
            "juggling_person"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🤹‍♂️",
        description: "man juggling",
        category: "People & Body",
        aliases: [
            "man_juggling"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "🤹‍♀️",
        description: "woman juggling",
        category: "People & Body",
        aliases: [
            "woman_juggling"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2",
        skinTones: true
    },
    {
        emoji: "🧘",
        description: "person in lotus position",
        category: "People & Body",
        aliases: [
            "lotus_position"
        ],
        tags: [
            "meditation"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🧘‍♂️",
        description: "man in lotus position",
        category: "People & Body",
        aliases: [
            "lotus_position_man"
        ],
        tags: [
            "meditation"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🧘‍♀️",
        description: "woman in lotus position",
        category: "People & Body",
        aliases: [
            "lotus_position_woman"
        ],
        tags: [
            "meditation"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1",
        skinTones: true
    },
    {
        emoji: "🛀",
        description: "person taking bath",
        category: "People & Body",
        aliases: [
            "bath"
        ],
        tags: [
            "shower"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "🛌",
        description: "person in bed",
        category: "People & Body",
        aliases: [
            "sleeping_bed"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1",
        skinTones: true
    },
    {
        emoji: "🧑‍🤝‍🧑",
        description: "people holding hands",
        category: "People & Body",
        aliases: [
            "people_holding_hands"
        ],
        tags: [
            "couple",
            "date"
        ],
        unicodeVersion: "12.0",
        iosVersion: "13.0",
        skinTones: true
    },
    {
        emoji: "👭",
        description: "women holding hands",
        category: "People & Body",
        aliases: [
            "two_women_holding_hands"
        ],
        tags: [
            "couple",
            "date"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "👫",
        description: "woman and man holding hands",
        category: "People & Body",
        aliases: [
            "couple"
        ],
        tags: [
            "date"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "👬",
        description: "men holding hands",
        category: "People & Body",
        aliases: [
            "two_men_holding_hands"
        ],
        tags: [
            "couple",
            "date"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0",
        skinTones: true
    },
    {
        emoji: "💏",
        description: "kiss",
        category: "People & Body",
        aliases: [
            "couplekiss"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "👩‍❤️‍💋‍👨",
        description: "kiss: woman, man",
        category: "People & Body",
        aliases: [
            "couplekiss_man_woman"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "👨‍❤️‍💋‍👨",
        description: "kiss: man, man",
        category: "People & Body",
        aliases: [
            "couplekiss_man_man"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "👩‍❤️‍💋‍👩",
        description: "kiss: woman, woman",
        category: "People & Body",
        aliases: [
            "couplekiss_woman_woman"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "💑",
        description: "couple with heart",
        category: "People & Body",
        aliases: [
            "couple_with_heart"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "👩‍❤️‍👨",
        description: "couple with heart: woman, man",
        category: "People & Body",
        aliases: [
            "couple_with_heart_woman_man"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "👨‍❤️‍👨",
        description: "couple with heart: man, man",
        category: "People & Body",
        aliases: [
            "couple_with_heart_man_man"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "👩‍❤️‍👩",
        description: "couple with heart: woman, woman",
        category: "People & Body",
        aliases: [
            "couple_with_heart_woman_woman"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "👪",
        description: "family",
        category: "People & Body",
        aliases: [
            "family"
        ],
        tags: [
            "home",
            "parents",
            "child"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "👨‍👩‍👦",
        description: "family: man, woman, boy",
        category: "People & Body",
        aliases: [
            "family_man_woman_boy"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "👨‍👩‍👧",
        description: "family: man, woman, girl",
        category: "People & Body",
        aliases: [
            "family_man_woman_girl"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "👨‍👩‍👧‍👦",
        description: "family: man, woman, girl, boy",
        category: "People & Body",
        aliases: [
            "family_man_woman_girl_boy"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "👨‍👩‍👦‍👦",
        description: "family: man, woman, boy, boy",
        category: "People & Body",
        aliases: [
            "family_man_woman_boy_boy"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "👨‍👩‍👧‍👧",
        description: "family: man, woman, girl, girl",
        category: "People & Body",
        aliases: [
            "family_man_woman_girl_girl"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "👨‍👨‍👦",
        description: "family: man, man, boy",
        category: "People & Body",
        aliases: [
            "family_man_man_boy"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "👨‍👨‍👧",
        description: "family: man, man, girl",
        category: "People & Body",
        aliases: [
            "family_man_man_girl"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "👨‍👨‍👧‍👦",
        description: "family: man, man, girl, boy",
        category: "People & Body",
        aliases: [
            "family_man_man_girl_boy"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "👨‍👨‍👦‍👦",
        description: "family: man, man, boy, boy",
        category: "People & Body",
        aliases: [
            "family_man_man_boy_boy"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "👨‍👨‍👧‍👧",
        description: "family: man, man, girl, girl",
        category: "People & Body",
        aliases: [
            "family_man_man_girl_girl"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "👩‍👩‍👦",
        description: "family: woman, woman, boy",
        category: "People & Body",
        aliases: [
            "family_woman_woman_boy"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "👩‍👩‍👧",
        description: "family: woman, woman, girl",
        category: "People & Body",
        aliases: [
            "family_woman_woman_girl"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "👩‍👩‍👧‍👦",
        description: "family: woman, woman, girl, boy",
        category: "People & Body",
        aliases: [
            "family_woman_woman_girl_boy"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "👩‍👩‍👦‍👦",
        description: "family: woman, woman, boy, boy",
        category: "People & Body",
        aliases: [
            "family_woman_woman_boy_boy"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "👩‍👩‍👧‍👧",
        description: "family: woman, woman, girl, girl",
        category: "People & Body",
        aliases: [
            "family_woman_woman_girl_girl"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "👨‍👦",
        description: "family: man, boy",
        category: "People & Body",
        aliases: [
            "family_man_boy"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "10.0"
    },
    {
        emoji: "👨‍👦‍👦",
        description: "family: man, boy, boy",
        category: "People & Body",
        aliases: [
            "family_man_boy_boy"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "10.0"
    },
    {
        emoji: "👨‍👧",
        description: "family: man, girl",
        category: "People & Body",
        aliases: [
            "family_man_girl"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "10.0"
    },
    {
        emoji: "👨‍👧‍👦",
        description: "family: man, girl, boy",
        category: "People & Body",
        aliases: [
            "family_man_girl_boy"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "10.0"
    },
    {
        emoji: "👨‍👧‍👧",
        description: "family: man, girl, girl",
        category: "People & Body",
        aliases: [
            "family_man_girl_girl"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "10.0"
    },
    {
        emoji: "👩‍👦",
        description: "family: woman, boy",
        category: "People & Body",
        aliases: [
            "family_woman_boy"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "10.0"
    },
    {
        emoji: "👩‍👦‍👦",
        description: "family: woman, boy, boy",
        category: "People & Body",
        aliases: [
            "family_woman_boy_boy"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "10.0"
    },
    {
        emoji: "👩‍👧",
        description: "family: woman, girl",
        category: "People & Body",
        aliases: [
            "family_woman_girl"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "10.0"
    },
    {
        emoji: "👩‍👧‍👦",
        description: "family: woman, girl, boy",
        category: "People & Body",
        aliases: [
            "family_woman_girl_boy"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "10.0"
    },
    {
        emoji: "👩‍👧‍👧",
        description: "family: woman, girl, girl",
        category: "People & Body",
        aliases: [
            "family_woman_girl_girl"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "10.0"
    },
    {
        emoji: "🗣️",
        description: "speaking head",
        category: "People & Body",
        aliases: [
            "speaking_head"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "👤",
        description: "bust in silhouette",
        category: "People & Body",
        aliases: [
            "bust_in_silhouette"
        ],
        tags: [
            "user"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "👥",
        description: "busts in silhouette",
        category: "People & Body",
        aliases: [
            "busts_in_silhouette"
        ],
        tags: [
            "users",
            "group",
            "team"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🫂",
        description: "people hugging",
        category: "People & Body",
        aliases: [
            "people_hugging"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "👣",
        description: "footprints",
        category: "People & Body",
        aliases: [
            "footprints"
        ],
        tags: [
            "feet",
            "tracks"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐵",
        description: "monkey face",
        category: "Animals & Nature",
        aliases: [
            "monkey_face"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐒",
        description: "monkey",
        category: "Animals & Nature",
        aliases: [
            "monkey"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🦍",
        description: "gorilla",
        category: "Animals & Nature",
        aliases: [
            "gorilla"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🦧",
        description: "orangutan",
        category: "Animals & Nature",
        aliases: [
            "orangutan"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🐶",
        description: "dog face",
        category: "Animals & Nature",
        aliases: [
            "dog"
        ],
        tags: [
            "pet"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐕",
        description: "dog",
        category: "Animals & Nature",
        aliases: [
            "dog2"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🦮",
        description: "guide dog",
        category: "Animals & Nature",
        aliases: [
            "guide_dog"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🐕‍🦺",
        description: "service dog",
        category: "Animals & Nature",
        aliases: [
            "service_dog"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🐩",
        description: "poodle",
        category: "Animals & Nature",
        aliases: [
            "poodle"
        ],
        tags: [
            "dog"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐺",
        description: "wolf",
        category: "Animals & Nature",
        aliases: [
            "wolf"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🦊",
        description: "fox",
        category: "Animals & Nature",
        aliases: [
            "fox_face"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🦝",
        description: "raccoon",
        category: "Animals & Nature",
        aliases: [
            "raccoon"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🐱",
        description: "cat face",
        category: "Animals & Nature",
        aliases: [
            "cat"
        ],
        tags: [
            "pet"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐈",
        description: "cat",
        category: "Animals & Nature",
        aliases: [
            "cat2"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐈‍⬛",
        description: "black cat",
        category: "Animals & Nature",
        aliases: [
            "black_cat"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🦁",
        description: "lion",
        category: "Animals & Nature",
        aliases: [
            "lion"
        ],
        tags: [],
        unicodeVersion: "8.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🐯",
        description: "tiger face",
        category: "Animals & Nature",
        aliases: [
            "tiger"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐅",
        description: "tiger",
        category: "Animals & Nature",
        aliases: [
            "tiger2"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐆",
        description: "leopard",
        category: "Animals & Nature",
        aliases: [
            "leopard"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐴",
        description: "horse face",
        category: "Animals & Nature",
        aliases: [
            "horse"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐎",
        description: "horse",
        category: "Animals & Nature",
        aliases: [
            "racehorse"
        ],
        tags: [
            "speed"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🦄",
        description: "unicorn",
        category: "Animals & Nature",
        aliases: [
            "unicorn"
        ],
        tags: [],
        unicodeVersion: "8.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🦓",
        description: "zebra",
        category: "Animals & Nature",
        aliases: [
            "zebra"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🦌",
        description: "deer",
        category: "Animals & Nature",
        aliases: [
            "deer"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🦬",
        description: "bison",
        category: "Animals & Nature",
        aliases: [
            "bison"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🐮",
        description: "cow face",
        category: "Animals & Nature",
        aliases: [
            "cow"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐂",
        description: "ox",
        category: "Animals & Nature",
        aliases: [
            "ox"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐃",
        description: "water buffalo",
        category: "Animals & Nature",
        aliases: [
            "water_buffalo"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐄",
        description: "cow",
        category: "Animals & Nature",
        aliases: [
            "cow2"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐷",
        description: "pig face",
        category: "Animals & Nature",
        aliases: [
            "pig"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐖",
        description: "pig",
        category: "Animals & Nature",
        aliases: [
            "pig2"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐗",
        description: "boar",
        category: "Animals & Nature",
        aliases: [
            "boar"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐽",
        description: "pig nose",
        category: "Animals & Nature",
        aliases: [
            "pig_nose"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐏",
        description: "ram",
        category: "Animals & Nature",
        aliases: [
            "ram"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐑",
        description: "ewe",
        category: "Animals & Nature",
        aliases: [
            "sheep"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐐",
        description: "goat",
        category: "Animals & Nature",
        aliases: [
            "goat"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐪",
        description: "camel",
        category: "Animals & Nature",
        aliases: [
            "dromedary_camel"
        ],
        tags: [
            "desert"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐫",
        description: "two-hump camel",
        category: "Animals & Nature",
        aliases: [
            "camel"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🦙",
        description: "llama",
        category: "Animals & Nature",
        aliases: [
            "llama"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🦒",
        description: "giraffe",
        category: "Animals & Nature",
        aliases: [
            "giraffe"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🐘",
        description: "elephant",
        category: "Animals & Nature",
        aliases: [
            "elephant"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🦣",
        description: "mammoth",
        category: "Animals & Nature",
        aliases: [
            "mammoth"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🦏",
        description: "rhinoceros",
        category: "Animals & Nature",
        aliases: [
            "rhinoceros"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🦛",
        description: "hippopotamus",
        category: "Animals & Nature",
        aliases: [
            "hippopotamus"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🐭",
        description: "mouse face",
        category: "Animals & Nature",
        aliases: [
            "mouse"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐁",
        description: "mouse",
        category: "Animals & Nature",
        aliases: [
            "mouse2"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐀",
        description: "rat",
        category: "Animals & Nature",
        aliases: [
            "rat"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐹",
        description: "hamster",
        category: "Animals & Nature",
        aliases: [
            "hamster"
        ],
        tags: [
            "pet"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐰",
        description: "rabbit face",
        category: "Animals & Nature",
        aliases: [
            "rabbit"
        ],
        tags: [
            "bunny"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐇",
        description: "rabbit",
        category: "Animals & Nature",
        aliases: [
            "rabbit2"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐿️",
        description: "chipmunk",
        category: "Animals & Nature",
        aliases: [
            "chipmunk"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🦫",
        description: "beaver",
        category: "Animals & Nature",
        aliases: [
            "beaver"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🦔",
        description: "hedgehog",
        category: "Animals & Nature",
        aliases: [
            "hedgehog"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🦇",
        description: "bat",
        category: "Animals & Nature",
        aliases: [
            "bat"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🐻",
        description: "bear",
        category: "Animals & Nature",
        aliases: [
            "bear"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐻‍❄️",
        description: "polar bear",
        category: "Animals & Nature",
        aliases: [
            "polar_bear"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🐨",
        description: "koala",
        category: "Animals & Nature",
        aliases: [
            "koala"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐼",
        description: "panda",
        category: "Animals & Nature",
        aliases: [
            "panda_face"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🦥",
        description: "sloth",
        category: "Animals & Nature",
        aliases: [
            "sloth"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🦦",
        description: "otter",
        category: "Animals & Nature",
        aliases: [
            "otter"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🦨",
        description: "skunk",
        category: "Animals & Nature",
        aliases: [
            "skunk"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🦘",
        description: "kangaroo",
        category: "Animals & Nature",
        aliases: [
            "kangaroo"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🦡",
        description: "badger",
        category: "Animals & Nature",
        aliases: [
            "badger"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🐾",
        description: "paw prints",
        category: "Animals & Nature",
        aliases: [
            "feet",
            "paw_prints"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🦃",
        description: "turkey",
        category: "Animals & Nature",
        aliases: [
            "turkey"
        ],
        tags: [
            "thanksgiving"
        ],
        unicodeVersion: "8.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🐔",
        description: "chicken",
        category: "Animals & Nature",
        aliases: [
            "chicken"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐓",
        description: "rooster",
        category: "Animals & Nature",
        aliases: [
            "rooster"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐣",
        description: "hatching chick",
        category: "Animals & Nature",
        aliases: [
            "hatching_chick"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐤",
        description: "baby chick",
        category: "Animals & Nature",
        aliases: [
            "baby_chick"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐥",
        description: "front-facing baby chick",
        category: "Animals & Nature",
        aliases: [
            "hatched_chick"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐦",
        description: "bird",
        category: "Animals & Nature",
        aliases: [
            "bird"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐧",
        description: "penguin",
        category: "Animals & Nature",
        aliases: [
            "penguin"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🕊️",
        description: "dove",
        category: "Animals & Nature",
        aliases: [
            "dove"
        ],
        tags: [
            "peace"
        ],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🦅",
        description: "eagle",
        category: "Animals & Nature",
        aliases: [
            "eagle"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🦆",
        description: "duck",
        category: "Animals & Nature",
        aliases: [
            "duck"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🦢",
        description: "swan",
        category: "Animals & Nature",
        aliases: [
            "swan"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🦉",
        description: "owl",
        category: "Animals & Nature",
        aliases: [
            "owl"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🦤",
        description: "dodo",
        category: "Animals & Nature",
        aliases: [
            "dodo"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🪶",
        description: "feather",
        category: "Animals & Nature",
        aliases: [
            "feather"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🦩",
        description: "flamingo",
        category: "Animals & Nature",
        aliases: [
            "flamingo"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🦚",
        description: "peacock",
        category: "Animals & Nature",
        aliases: [
            "peacock"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🦜",
        description: "parrot",
        category: "Animals & Nature",
        aliases: [
            "parrot"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🐸",
        description: "frog",
        category: "Animals & Nature",
        aliases: [
            "frog"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐊",
        description: "crocodile",
        category: "Animals & Nature",
        aliases: [
            "crocodile"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐢",
        description: "turtle",
        category: "Animals & Nature",
        aliases: [
            "turtle"
        ],
        tags: [
            "slow"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🦎",
        description: "lizard",
        category: "Animals & Nature",
        aliases: [
            "lizard"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🐍",
        description: "snake",
        category: "Animals & Nature",
        aliases: [
            "snake"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐲",
        description: "dragon face",
        category: "Animals & Nature",
        aliases: [
            "dragon_face"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐉",
        description: "dragon",
        category: "Animals & Nature",
        aliases: [
            "dragon"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🦕",
        description: "sauropod",
        category: "Animals & Nature",
        aliases: [
            "sauropod"
        ],
        tags: [
            "dinosaur"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🦖",
        description: "T-Rex",
        category: "Animals & Nature",
        aliases: [
            "t-rex"
        ],
        tags: [
            "dinosaur"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🐳",
        description: "spouting whale",
        category: "Animals & Nature",
        aliases: [
            "whale"
        ],
        tags: [
            "sea"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐋",
        description: "whale",
        category: "Animals & Nature",
        aliases: [
            "whale2"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐬",
        description: "dolphin",
        category: "Animals & Nature",
        aliases: [
            "dolphin",
            "flipper"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🦭",
        description: "seal",
        category: "Animals & Nature",
        aliases: [
            "seal"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🐟",
        description: "fish",
        category: "Animals & Nature",
        aliases: [
            "fish"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐠",
        description: "tropical fish",
        category: "Animals & Nature",
        aliases: [
            "tropical_fish"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐡",
        description: "blowfish",
        category: "Animals & Nature",
        aliases: [
            "blowfish"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🦈",
        description: "shark",
        category: "Animals & Nature",
        aliases: [
            "shark"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🐙",
        description: "octopus",
        category: "Animals & Nature",
        aliases: [
            "octopus"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐚",
        description: "spiral shell",
        category: "Animals & Nature",
        aliases: [
            "shell"
        ],
        tags: [
            "sea",
            "beach"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐌",
        description: "snail",
        category: "Animals & Nature",
        aliases: [
            "snail"
        ],
        tags: [
            "slow"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🦋",
        description: "butterfly",
        category: "Animals & Nature",
        aliases: [
            "butterfly"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🐛",
        description: "bug",
        category: "Animals & Nature",
        aliases: [
            "bug"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐜",
        description: "ant",
        category: "Animals & Nature",
        aliases: [
            "ant"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🐝",
        description: "honeybee",
        category: "Animals & Nature",
        aliases: [
            "bee",
            "honeybee"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🪲",
        description: "beetle",
        category: "Animals & Nature",
        aliases: [
            "beetle"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🐞",
        description: "lady beetle",
        category: "Animals & Nature",
        aliases: [
            "lady_beetle"
        ],
        tags: [
            "bug"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🦗",
        description: "cricket",
        category: "Animals & Nature",
        aliases: [
            "cricket"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🪳",
        description: "cockroach",
        category: "Animals & Nature",
        aliases: [
            "cockroach"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🕷️",
        description: "spider",
        category: "Animals & Nature",
        aliases: [
            "spider"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🕸️",
        description: "spider web",
        category: "Animals & Nature",
        aliases: [
            "spider_web"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🦂",
        description: "scorpion",
        category: "Animals & Nature",
        aliases: [
            "scorpion"
        ],
        tags: [],
        unicodeVersion: "8.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🦟",
        description: "mosquito",
        category: "Animals & Nature",
        aliases: [
            "mosquito"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🪰",
        description: "fly",
        category: "Animals & Nature",
        aliases: [
            "fly"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🪱",
        description: "worm",
        category: "Animals & Nature",
        aliases: [
            "worm"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🦠",
        description: "microbe",
        category: "Animals & Nature",
        aliases: [
            "microbe"
        ],
        tags: [
            "germ"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "💐",
        description: "bouquet",
        category: "Animals & Nature",
        aliases: [
            "bouquet"
        ],
        tags: [
            "flowers"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌸",
        description: "cherry blossom",
        category: "Animals & Nature",
        aliases: [
            "cherry_blossom"
        ],
        tags: [
            "flower",
            "spring"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💮",
        description: "white flower",
        category: "Animals & Nature",
        aliases: [
            "white_flower"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🏵️",
        description: "rosette",
        category: "Animals & Nature",
        aliases: [
            "rosette"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🌹",
        description: "rose",
        category: "Animals & Nature",
        aliases: [
            "rose"
        ],
        tags: [
            "flower"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🥀",
        description: "wilted flower",
        category: "Animals & Nature",
        aliases: [
            "wilted_flower"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🌺",
        description: "hibiscus",
        category: "Animals & Nature",
        aliases: [
            "hibiscus"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌻",
        description: "sunflower",
        category: "Animals & Nature",
        aliases: [
            "sunflower"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌼",
        description: "blossom",
        category: "Animals & Nature",
        aliases: [
            "blossom"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌷",
        description: "tulip",
        category: "Animals & Nature",
        aliases: [
            "tulip"
        ],
        tags: [
            "flower"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌱",
        description: "seedling",
        category: "Animals & Nature",
        aliases: [
            "seedling"
        ],
        tags: [
            "plant"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🪴",
        description: "potted plant",
        category: "Animals & Nature",
        aliases: [
            "potted_plant"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🌲",
        description: "evergreen tree",
        category: "Animals & Nature",
        aliases: [
            "evergreen_tree"
        ],
        tags: [
            "wood"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌳",
        description: "deciduous tree",
        category: "Animals & Nature",
        aliases: [
            "deciduous_tree"
        ],
        tags: [
            "wood"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌴",
        description: "palm tree",
        category: "Animals & Nature",
        aliases: [
            "palm_tree"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌵",
        description: "cactus",
        category: "Animals & Nature",
        aliases: [
            "cactus"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌾",
        description: "sheaf of rice",
        category: "Animals & Nature",
        aliases: [
            "ear_of_rice"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌿",
        description: "herb",
        category: "Animals & Nature",
        aliases: [
            "herb"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "☘️",
        description: "shamrock",
        category: "Animals & Nature",
        aliases: [
            "shamrock"
        ],
        tags: [],
        unicodeVersion: "4.1",
        iosVersion: "9.1"
    },
    {
        emoji: "🍀",
        description: "four leaf clover",
        category: "Animals & Nature",
        aliases: [
            "four_leaf_clover"
        ],
        tags: [
            "luck"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍁",
        description: "maple leaf",
        category: "Animals & Nature",
        aliases: [
            "maple_leaf"
        ],
        tags: [
            "canada"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍂",
        description: "fallen leaf",
        category: "Animals & Nature",
        aliases: [
            "fallen_leaf"
        ],
        tags: [
            "autumn"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍃",
        description: "leaf fluttering in wind",
        category: "Animals & Nature",
        aliases: [
            "leaves"
        ],
        tags: [
            "leaf"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍇",
        description: "grapes",
        category: "Food & Drink",
        aliases: [
            "grapes"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍈",
        description: "melon",
        category: "Food & Drink",
        aliases: [
            "melon"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍉",
        description: "watermelon",
        category: "Food & Drink",
        aliases: [
            "watermelon"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍊",
        description: "tangerine",
        category: "Food & Drink",
        aliases: [
            "tangerine",
            "orange",
            "mandarin"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍋",
        description: "lemon",
        category: "Food & Drink",
        aliases: [
            "lemon"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍌",
        description: "banana",
        category: "Food & Drink",
        aliases: [
            "banana"
        ],
        tags: [
            "fruit"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍍",
        description: "pineapple",
        category: "Food & Drink",
        aliases: [
            "pineapple"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🥭",
        description: "mango",
        category: "Food & Drink",
        aliases: [
            "mango"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🍎",
        description: "red apple",
        category: "Food & Drink",
        aliases: [
            "apple"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍏",
        description: "green apple",
        category: "Food & Drink",
        aliases: [
            "green_apple"
        ],
        tags: [
            "fruit"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍐",
        description: "pear",
        category: "Food & Drink",
        aliases: [
            "pear"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍑",
        description: "peach",
        category: "Food & Drink",
        aliases: [
            "peach"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍒",
        description: "cherries",
        category: "Food & Drink",
        aliases: [
            "cherries"
        ],
        tags: [
            "fruit"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍓",
        description: "strawberry",
        category: "Food & Drink",
        aliases: [
            "strawberry"
        ],
        tags: [
            "fruit"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🫐",
        description: "blueberries",
        category: "Food & Drink",
        aliases: [
            "blueberries"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🥝",
        description: "kiwi fruit",
        category: "Food & Drink",
        aliases: [
            "kiwi_fruit"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🍅",
        description: "tomato",
        category: "Food & Drink",
        aliases: [
            "tomato"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🫒",
        description: "olive",
        category: "Food & Drink",
        aliases: [
            "olive"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🥥",
        description: "coconut",
        category: "Food & Drink",
        aliases: [
            "coconut"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🥑",
        description: "avocado",
        category: "Food & Drink",
        aliases: [
            "avocado"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🍆",
        description: "eggplant",
        category: "Food & Drink",
        aliases: [
            "eggplant"
        ],
        tags: [
            "aubergine"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🥔",
        description: "potato",
        category: "Food & Drink",
        aliases: [
            "potato"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🥕",
        description: "carrot",
        category: "Food & Drink",
        aliases: [
            "carrot"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🌽",
        description: "ear of corn",
        category: "Food & Drink",
        aliases: [
            "corn"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌶️",
        description: "hot pepper",
        category: "Food & Drink",
        aliases: [
            "hot_pepper"
        ],
        tags: [
            "spicy"
        ],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🫑",
        description: "bell pepper",
        category: "Food & Drink",
        aliases: [
            "bell_pepper"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🥒",
        description: "cucumber",
        category: "Food & Drink",
        aliases: [
            "cucumber"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🥬",
        description: "leafy green",
        category: "Food & Drink",
        aliases: [
            "leafy_green"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🥦",
        description: "broccoli",
        category: "Food & Drink",
        aliases: [
            "broccoli"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🧄",
        description: "garlic",
        category: "Food & Drink",
        aliases: [
            "garlic"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🧅",
        description: "onion",
        category: "Food & Drink",
        aliases: [
            "onion"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🍄",
        description: "mushroom",
        category: "Food & Drink",
        aliases: [
            "mushroom"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🥜",
        description: "peanuts",
        category: "Food & Drink",
        aliases: [
            "peanuts"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🌰",
        description: "chestnut",
        category: "Food & Drink",
        aliases: [
            "chestnut"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍞",
        description: "bread",
        category: "Food & Drink",
        aliases: [
            "bread"
        ],
        tags: [
            "toast"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🥐",
        description: "croissant",
        category: "Food & Drink",
        aliases: [
            "croissant"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🥖",
        description: "baguette bread",
        category: "Food & Drink",
        aliases: [
            "baguette_bread"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🫓",
        description: "flatbread",
        category: "Food & Drink",
        aliases: [
            "flatbread"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🥨",
        description: "pretzel",
        category: "Food & Drink",
        aliases: [
            "pretzel"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🥯",
        description: "bagel",
        category: "Food & Drink",
        aliases: [
            "bagel"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🥞",
        description: "pancakes",
        category: "Food & Drink",
        aliases: [
            "pancakes"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🧇",
        description: "waffle",
        category: "Food & Drink",
        aliases: [
            "waffle"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🧀",
        description: "cheese wedge",
        category: "Food & Drink",
        aliases: [
            "cheese"
        ],
        tags: [],
        unicodeVersion: "8.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🍖",
        description: "meat on bone",
        category: "Food & Drink",
        aliases: [
            "meat_on_bone"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍗",
        description: "poultry leg",
        category: "Food & Drink",
        aliases: [
            "poultry_leg"
        ],
        tags: [
            "meat",
            "chicken"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🥩",
        description: "cut of meat",
        category: "Food & Drink",
        aliases: [
            "cut_of_meat"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🥓",
        description: "bacon",
        category: "Food & Drink",
        aliases: [
            "bacon"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🍔",
        description: "hamburger",
        category: "Food & Drink",
        aliases: [
            "hamburger"
        ],
        tags: [
            "burger"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍟",
        description: "french fries",
        category: "Food & Drink",
        aliases: [
            "fries"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍕",
        description: "pizza",
        category: "Food & Drink",
        aliases: [
            "pizza"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌭",
        description: "hot dog",
        category: "Food & Drink",
        aliases: [
            "hotdog"
        ],
        tags: [],
        unicodeVersion: "8.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🥪",
        description: "sandwich",
        category: "Food & Drink",
        aliases: [
            "sandwich"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🌮",
        description: "taco",
        category: "Food & Drink",
        aliases: [
            "taco"
        ],
        tags: [],
        unicodeVersion: "8.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🌯",
        description: "burrito",
        category: "Food & Drink",
        aliases: [
            "burrito"
        ],
        tags: [],
        unicodeVersion: "8.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🫔",
        description: "tamale",
        category: "Food & Drink",
        aliases: [
            "tamale"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🥙",
        description: "stuffed flatbread",
        category: "Food & Drink",
        aliases: [
            "stuffed_flatbread"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🧆",
        description: "falafel",
        category: "Food & Drink",
        aliases: [
            "falafel"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🥚",
        description: "egg",
        category: "Food & Drink",
        aliases: [
            "egg"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🍳",
        description: "cooking",
        category: "Food & Drink",
        aliases: [
            "fried_egg"
        ],
        tags: [
            "breakfast"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🥘",
        description: "shallow pan of food",
        category: "Food & Drink",
        aliases: [
            "shallow_pan_of_food"
        ],
        tags: [
            "paella",
            "curry"
        ],
        unicodeVersion: "",
        iosVersion: "10.2"
    },
    {
        emoji: "🍲",
        description: "pot of food",
        category: "Food & Drink",
        aliases: [
            "stew"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🫕",
        description: "fondue",
        category: "Food & Drink",
        aliases: [
            "fondue"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🥣",
        description: "bowl with spoon",
        category: "Food & Drink",
        aliases: [
            "bowl_with_spoon"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🥗",
        description: "green salad",
        category: "Food & Drink",
        aliases: [
            "green_salad"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🍿",
        description: "popcorn",
        category: "Food & Drink",
        aliases: [
            "popcorn"
        ],
        tags: [],
        unicodeVersion: "8.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🧈",
        description: "butter",
        category: "Food & Drink",
        aliases: [
            "butter"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🧂",
        description: "salt",
        category: "Food & Drink",
        aliases: [
            "salt"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🥫",
        description: "canned food",
        category: "Food & Drink",
        aliases: [
            "canned_food"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🍱",
        description: "bento box",
        category: "Food & Drink",
        aliases: [
            "bento"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍘",
        description: "rice cracker",
        category: "Food & Drink",
        aliases: [
            "rice_cracker"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍙",
        description: "rice ball",
        category: "Food & Drink",
        aliases: [
            "rice_ball"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍚",
        description: "cooked rice",
        category: "Food & Drink",
        aliases: [
            "rice"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍛",
        description: "curry rice",
        category: "Food & Drink",
        aliases: [
            "curry"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍜",
        description: "steaming bowl",
        category: "Food & Drink",
        aliases: [
            "ramen"
        ],
        tags: [
            "noodle"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍝",
        description: "spaghetti",
        category: "Food & Drink",
        aliases: [
            "spaghetti"
        ],
        tags: [
            "pasta"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍠",
        description: "roasted sweet potato",
        category: "Food & Drink",
        aliases: [
            "sweet_potato"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍢",
        description: "oden",
        category: "Food & Drink",
        aliases: [
            "oden"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍣",
        description: "sushi",
        category: "Food & Drink",
        aliases: [
            "sushi"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍤",
        description: "fried shrimp",
        category: "Food & Drink",
        aliases: [
            "fried_shrimp"
        ],
        tags: [
            "tempura"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍥",
        description: "fish cake with swirl",
        category: "Food & Drink",
        aliases: [
            "fish_cake"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🥮",
        description: "moon cake",
        category: "Food & Drink",
        aliases: [
            "moon_cake"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🍡",
        description: "dango",
        category: "Food & Drink",
        aliases: [
            "dango"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🥟",
        description: "dumpling",
        category: "Food & Drink",
        aliases: [
            "dumpling"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🥠",
        description: "fortune cookie",
        category: "Food & Drink",
        aliases: [
            "fortune_cookie"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🥡",
        description: "takeout box",
        category: "Food & Drink",
        aliases: [
            "takeout_box"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🦀",
        description: "crab",
        category: "Food & Drink",
        aliases: [
            "crab"
        ],
        tags: [],
        unicodeVersion: "8.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🦞",
        description: "lobster",
        category: "Food & Drink",
        aliases: [
            "lobster"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🦐",
        description: "shrimp",
        category: "Food & Drink",
        aliases: [
            "shrimp"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🦑",
        description: "squid",
        category: "Food & Drink",
        aliases: [
            "squid"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🦪",
        description: "oyster",
        category: "Food & Drink",
        aliases: [
            "oyster"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🍦",
        description: "soft ice cream",
        category: "Food & Drink",
        aliases: [
            "icecream"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍧",
        description: "shaved ice",
        category: "Food & Drink",
        aliases: [
            "shaved_ice"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍨",
        description: "ice cream",
        category: "Food & Drink",
        aliases: [
            "ice_cream"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍩",
        description: "doughnut",
        category: "Food & Drink",
        aliases: [
            "doughnut"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍪",
        description: "cookie",
        category: "Food & Drink",
        aliases: [
            "cookie"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🎂",
        description: "birthday cake",
        category: "Food & Drink",
        aliases: [
            "birthday"
        ],
        tags: [
            "party"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍰",
        description: "shortcake",
        category: "Food & Drink",
        aliases: [
            "cake"
        ],
        tags: [
            "dessert"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🧁",
        description: "cupcake",
        category: "Food & Drink",
        aliases: [
            "cupcake"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🥧",
        description: "pie",
        category: "Food & Drink",
        aliases: [
            "pie"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🍫",
        description: "chocolate bar",
        category: "Food & Drink",
        aliases: [
            "chocolate_bar"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍬",
        description: "candy",
        category: "Food & Drink",
        aliases: [
            "candy"
        ],
        tags: [
            "sweet"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍭",
        description: "lollipop",
        category: "Food & Drink",
        aliases: [
            "lollipop"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍮",
        description: "custard",
        category: "Food & Drink",
        aliases: [
            "custard"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍯",
        description: "honey pot",
        category: "Food & Drink",
        aliases: [
            "honey_pot"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍼",
        description: "baby bottle",
        category: "Food & Drink",
        aliases: [
            "baby_bottle"
        ],
        tags: [
            "milk"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🥛",
        description: "glass of milk",
        category: "Food & Drink",
        aliases: [
            "milk_glass"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "☕",
        description: "hot beverage",
        category: "Food & Drink",
        aliases: [
            "coffee"
        ],
        tags: [
            "cafe",
            "espresso"
        ],
        unicodeVersion: "4.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🫖",
        description: "teapot",
        category: "Food & Drink",
        aliases: [
            "teapot"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🍵",
        description: "teacup without handle",
        category: "Food & Drink",
        aliases: [
            "tea"
        ],
        tags: [
            "green",
            "breakfast"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍶",
        description: "sake",
        category: "Food & Drink",
        aliases: [
            "sake"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍾",
        description: "bottle with popping cork",
        category: "Food & Drink",
        aliases: [
            "champagne"
        ],
        tags: [
            "bottle",
            "bubbly",
            "celebration"
        ],
        unicodeVersion: "8.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🍷",
        description: "wine glass",
        category: "Food & Drink",
        aliases: [
            "wine_glass"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍸",
        description: "cocktail glass",
        category: "Food & Drink",
        aliases: [
            "cocktail"
        ],
        tags: [
            "drink"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍹",
        description: "tropical drink",
        category: "Food & Drink",
        aliases: [
            "tropical_drink"
        ],
        tags: [
            "summer",
            "vacation"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍺",
        description: "beer mug",
        category: "Food & Drink",
        aliases: [
            "beer"
        ],
        tags: [
            "drink"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🍻",
        description: "clinking beer mugs",
        category: "Food & Drink",
        aliases: [
            "beers"
        ],
        tags: [
            "drinks"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🥂",
        description: "clinking glasses",
        category: "Food & Drink",
        aliases: [
            "clinking_glasses"
        ],
        tags: [
            "cheers",
            "toast"
        ],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🥃",
        description: "tumbler glass",
        category: "Food & Drink",
        aliases: [
            "tumbler_glass"
        ],
        tags: [
            "whisky"
        ],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🥤",
        description: "cup with straw",
        category: "Food & Drink",
        aliases: [
            "cup_with_straw"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🧋",
        description: "bubble tea",
        category: "Food & Drink",
        aliases: [
            "bubble_tea"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🧃",
        description: "beverage box",
        category: "Food & Drink",
        aliases: [
            "beverage_box"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🧉",
        description: "mate",
        category: "Food & Drink",
        aliases: [
            "mate"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🧊",
        description: "ice",
        category: "Food & Drink",
        aliases: [
            "ice_cube"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🥢",
        description: "chopsticks",
        category: "Food & Drink",
        aliases: [
            "chopsticks"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🍽️",
        description: "fork and knife with plate",
        category: "Food & Drink",
        aliases: [
            "plate_with_cutlery"
        ],
        tags: [
            "dining",
            "dinner"
        ],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🍴",
        description: "fork and knife",
        category: "Food & Drink",
        aliases: [
            "fork_and_knife"
        ],
        tags: [
            "cutlery"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🥄",
        description: "spoon",
        category: "Food & Drink",
        aliases: [
            "spoon"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🔪",
        description: "kitchen knife",
        category: "Food & Drink",
        aliases: [
            "hocho",
            "knife"
        ],
        tags: [
            "cut",
            "chop"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🏺",
        description: "amphora",
        category: "Food & Drink",
        aliases: [
            "amphora"
        ],
        tags: [],
        unicodeVersion: "8.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🌍",
        description: "globe showing Europe-Africa",
        category: "Travel & Places",
        aliases: [
            "earth_africa"
        ],
        tags: [
            "globe",
            "world",
            "international"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌎",
        description: "globe showing Americas",
        category: "Travel & Places",
        aliases: [
            "earth_americas"
        ],
        tags: [
            "globe",
            "world",
            "international"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌏",
        description: "globe showing Asia-Australia",
        category: "Travel & Places",
        aliases: [
            "earth_asia"
        ],
        tags: [
            "globe",
            "world",
            "international"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌐",
        description: "globe with meridians",
        category: "Travel & Places",
        aliases: [
            "globe_with_meridians"
        ],
        tags: [
            "world",
            "global",
            "international"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🗺️",
        description: "world map",
        category: "Travel & Places",
        aliases: [
            "world_map"
        ],
        tags: [
            "travel"
        ],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🗾",
        description: "map of Japan",
        category: "Travel & Places",
        aliases: [
            "japan"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🧭",
        description: "compass",
        category: "Travel & Places",
        aliases: [
            "compass"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🏔️",
        description: "snow-capped mountain",
        category: "Travel & Places",
        aliases: [
            "mountain_snow"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "⛰️",
        description: "mountain",
        category: "Travel & Places",
        aliases: [
            "mountain"
        ],
        tags: [],
        unicodeVersion: "5.2",
        iosVersion: "9.1"
    },
    {
        emoji: "🌋",
        description: "volcano",
        category: "Travel & Places",
        aliases: [
            "volcano"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🗻",
        description: "mount fuji",
        category: "Travel & Places",
        aliases: [
            "mount_fuji"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🏕️",
        description: "camping",
        category: "Travel & Places",
        aliases: [
            "camping"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🏖️",
        description: "beach with umbrella",
        category: "Travel & Places",
        aliases: [
            "beach_umbrella"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🏜️",
        description: "desert",
        category: "Travel & Places",
        aliases: [
            "desert"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🏝️",
        description: "desert island",
        category: "Travel & Places",
        aliases: [
            "desert_island"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🏞️",
        description: "national park",
        category: "Travel & Places",
        aliases: [
            "national_park"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🏟️",
        description: "stadium",
        category: "Travel & Places",
        aliases: [
            "stadium"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🏛️",
        description: "classical building",
        category: "Travel & Places",
        aliases: [
            "classical_building"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🏗️",
        description: "building construction",
        category: "Travel & Places",
        aliases: [
            "building_construction"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🧱",
        description: "brick",
        category: "Travel & Places",
        aliases: [
            "bricks"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🪨",
        description: "rock",
        category: "Travel & Places",
        aliases: [
            "rock"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🪵",
        description: "wood",
        category: "Travel & Places",
        aliases: [
            "wood"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🛖",
        description: "hut",
        category: "Travel & Places",
        aliases: [
            "hut"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🏘️",
        description: "houses",
        category: "Travel & Places",
        aliases: [
            "houses"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🏚️",
        description: "derelict house",
        category: "Travel & Places",
        aliases: [
            "derelict_house"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🏠",
        description: "house",
        category: "Travel & Places",
        aliases: [
            "house"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🏡",
        description: "house with garden",
        category: "Travel & Places",
        aliases: [
            "house_with_garden"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🏢",
        description: "office building",
        category: "Travel & Places",
        aliases: [
            "office"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🏣",
        description: "Japanese post office",
        category: "Travel & Places",
        aliases: [
            "post_office"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🏤",
        description: "post office",
        category: "Travel & Places",
        aliases: [
            "european_post_office"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🏥",
        description: "hospital",
        category: "Travel & Places",
        aliases: [
            "hospital"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🏦",
        description: "bank",
        category: "Travel & Places",
        aliases: [
            "bank"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🏨",
        description: "hotel",
        category: "Travel & Places",
        aliases: [
            "hotel"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🏩",
        description: "love hotel",
        category: "Travel & Places",
        aliases: [
            "love_hotel"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🏪",
        description: "convenience store",
        category: "Travel & Places",
        aliases: [
            "convenience_store"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🏫",
        description: "school",
        category: "Travel & Places",
        aliases: [
            "school"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🏬",
        description: "department store",
        category: "Travel & Places",
        aliases: [
            "department_store"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🏭",
        description: "factory",
        category: "Travel & Places",
        aliases: [
            "factory"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🏯",
        description: "Japanese castle",
        category: "Travel & Places",
        aliases: [
            "japanese_castle"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🏰",
        description: "castle",
        category: "Travel & Places",
        aliases: [
            "european_castle"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💒",
        description: "wedding",
        category: "Travel & Places",
        aliases: [
            "wedding"
        ],
        tags: [
            "marriage"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🗼",
        description: "Tokyo tower",
        category: "Travel & Places",
        aliases: [
            "tokyo_tower"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🗽",
        description: "Statue of Liberty",
        category: "Travel & Places",
        aliases: [
            "statue_of_liberty"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "⛪",
        description: "church",
        category: "Travel & Places",
        aliases: [
            "church"
        ],
        tags: [],
        unicodeVersion: "5.2",
        iosVersion: "6.0"
    },
    {
        emoji: "🕌",
        description: "mosque",
        category: "Travel & Places",
        aliases: [
            "mosque"
        ],
        tags: [],
        unicodeVersion: "8.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🛕",
        description: "hindu temple",
        category: "Travel & Places",
        aliases: [
            "hindu_temple"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🕍",
        description: "synagogue",
        category: "Travel & Places",
        aliases: [
            "synagogue"
        ],
        tags: [],
        unicodeVersion: "8.0",
        iosVersion: "9.1"
    },
    {
        emoji: "⛩️",
        description: "shinto shrine",
        category: "Travel & Places",
        aliases: [
            "shinto_shrine"
        ],
        tags: [],
        unicodeVersion: "5.2",
        iosVersion: "9.1"
    },
    {
        emoji: "🕋",
        description: "kaaba",
        category: "Travel & Places",
        aliases: [
            "kaaba"
        ],
        tags: [],
        unicodeVersion: "8.0",
        iosVersion: "9.1"
    },
    {
        emoji: "⛲",
        description: "fountain",
        category: "Travel & Places",
        aliases: [
            "fountain"
        ],
        tags: [],
        unicodeVersion: "5.2",
        iosVersion: "6.0"
    },
    {
        emoji: "⛺",
        description: "tent",
        category: "Travel & Places",
        aliases: [
            "tent"
        ],
        tags: [
            "camping"
        ],
        unicodeVersion: "5.2",
        iosVersion: "6.0"
    },
    {
        emoji: "🌁",
        description: "foggy",
        category: "Travel & Places",
        aliases: [
            "foggy"
        ],
        tags: [
            "karl"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌃",
        description: "night with stars",
        category: "Travel & Places",
        aliases: [
            "night_with_stars"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🏙️",
        description: "cityscape",
        category: "Travel & Places",
        aliases: [
            "cityscape"
        ],
        tags: [
            "skyline"
        ],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🌄",
        description: "sunrise over mountains",
        category: "Travel & Places",
        aliases: [
            "sunrise_over_mountains"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌅",
        description: "sunrise",
        category: "Travel & Places",
        aliases: [
            "sunrise"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌆",
        description: "cityscape at dusk",
        category: "Travel & Places",
        aliases: [
            "city_sunset"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌇",
        description: "sunset",
        category: "Travel & Places",
        aliases: [
            "city_sunrise"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌉",
        description: "bridge at night",
        category: "Travel & Places",
        aliases: [
            "bridge_at_night"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "♨️",
        description: "hot springs",
        category: "Travel & Places",
        aliases: [
            "hotsprings"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "🎠",
        description: "carousel horse",
        category: "Travel & Places",
        aliases: [
            "carousel_horse"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🎡",
        description: "ferris wheel",
        category: "Travel & Places",
        aliases: [
            "ferris_wheel"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🎢",
        description: "roller coaster",
        category: "Travel & Places",
        aliases: [
            "roller_coaster"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💈",
        description: "barber pole",
        category: "Travel & Places",
        aliases: [
            "barber"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🎪",
        description: "circus tent",
        category: "Travel & Places",
        aliases: [
            "circus_tent"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚂",
        description: "locomotive",
        category: "Travel & Places",
        aliases: [
            "steam_locomotive"
        ],
        tags: [
            "train"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚃",
        description: "railway car",
        category: "Travel & Places",
        aliases: [
            "railway_car"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚄",
        description: "high-speed train",
        category: "Travel & Places",
        aliases: [
            "bullettrain_side"
        ],
        tags: [
            "train"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚅",
        description: "bullet train",
        category: "Travel & Places",
        aliases: [
            "bullettrain_front"
        ],
        tags: [
            "train"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚆",
        description: "train",
        category: "Travel & Places",
        aliases: [
            "train2"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚇",
        description: "metro",
        category: "Travel & Places",
        aliases: [
            "metro"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚈",
        description: "light rail",
        category: "Travel & Places",
        aliases: [
            "light_rail"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚉",
        description: "station",
        category: "Travel & Places",
        aliases: [
            "station"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚊",
        description: "tram",
        category: "Travel & Places",
        aliases: [
            "tram"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚝",
        description: "monorail",
        category: "Travel & Places",
        aliases: [
            "monorail"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚞",
        description: "mountain railway",
        category: "Travel & Places",
        aliases: [
            "mountain_railway"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚋",
        description: "tram car",
        category: "Travel & Places",
        aliases: [
            "train"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚌",
        description: "bus",
        category: "Travel & Places",
        aliases: [
            "bus"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚍",
        description: "oncoming bus",
        category: "Travel & Places",
        aliases: [
            "oncoming_bus"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚎",
        description: "trolleybus",
        category: "Travel & Places",
        aliases: [
            "trolleybus"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚐",
        description: "minibus",
        category: "Travel & Places",
        aliases: [
            "minibus"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚑",
        description: "ambulance",
        category: "Travel & Places",
        aliases: [
            "ambulance"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚒",
        description: "fire engine",
        category: "Travel & Places",
        aliases: [
            "fire_engine"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚓",
        description: "police car",
        category: "Travel & Places",
        aliases: [
            "police_car"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚔",
        description: "oncoming police car",
        category: "Travel & Places",
        aliases: [
            "oncoming_police_car"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚕",
        description: "taxi",
        category: "Travel & Places",
        aliases: [
            "taxi"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚖",
        description: "oncoming taxi",
        category: "Travel & Places",
        aliases: [
            "oncoming_taxi"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚗",
        description: "automobile",
        category: "Travel & Places",
        aliases: [
            "car",
            "red_car"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚘",
        description: "oncoming automobile",
        category: "Travel & Places",
        aliases: [
            "oncoming_automobile"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚙",
        description: "sport utility vehicle",
        category: "Travel & Places",
        aliases: [
            "blue_car"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🛻",
        description: "pickup truck",
        category: "Travel & Places",
        aliases: [
            "pickup_truck"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🚚",
        description: "delivery truck",
        category: "Travel & Places",
        aliases: [
            "truck"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚛",
        description: "articulated lorry",
        category: "Travel & Places",
        aliases: [
            "articulated_lorry"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚜",
        description: "tractor",
        category: "Travel & Places",
        aliases: [
            "tractor"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🏎️",
        description: "racing car",
        category: "Travel & Places",
        aliases: [
            "racing_car"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🏍️",
        description: "motorcycle",
        category: "Travel & Places",
        aliases: [
            "motorcycle"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🛵",
        description: "motor scooter",
        category: "Travel & Places",
        aliases: [
            "motor_scooter"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🦽",
        description: "manual wheelchair",
        category: "Travel & Places",
        aliases: [
            "manual_wheelchair"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🦼",
        description: "motorized wheelchair",
        category: "Travel & Places",
        aliases: [
            "motorized_wheelchair"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🛺",
        description: "auto rickshaw",
        category: "Travel & Places",
        aliases: [
            "auto_rickshaw"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🚲",
        description: "bicycle",
        category: "Travel & Places",
        aliases: [
            "bike"
        ],
        tags: [
            "bicycle"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🛴",
        description: "kick scooter",
        category: "Travel & Places",
        aliases: [
            "kick_scooter"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🛹",
        description: "skateboard",
        category: "Travel & Places",
        aliases: [
            "skateboard"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🛼",
        description: "roller skate",
        category: "Travel & Places",
        aliases: [
            "roller_skate"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🚏",
        description: "bus stop",
        category: "Travel & Places",
        aliases: [
            "busstop"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🛣️",
        description: "motorway",
        category: "Travel & Places",
        aliases: [
            "motorway"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🛤️",
        description: "railway track",
        category: "Travel & Places",
        aliases: [
            "railway_track"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🛢️",
        description: "oil drum",
        category: "Travel & Places",
        aliases: [
            "oil_drum"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "⛽",
        description: "fuel pump",
        category: "Travel & Places",
        aliases: [
            "fuelpump"
        ],
        tags: [],
        unicodeVersion: "5.2",
        iosVersion: "6.0"
    },
    {
        emoji: "🚨",
        description: "police car light",
        category: "Travel & Places",
        aliases: [
            "rotating_light"
        ],
        tags: [
            "911",
            "emergency"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚥",
        description: "horizontal traffic light",
        category: "Travel & Places",
        aliases: [
            "traffic_light"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚦",
        description: "vertical traffic light",
        category: "Travel & Places",
        aliases: [
            "vertical_traffic_light"
        ],
        tags: [
            "semaphore"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🛑",
        description: "stop sign",
        category: "Travel & Places",
        aliases: [
            "stop_sign"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🚧",
        description: "construction",
        category: "Travel & Places",
        aliases: [
            "construction"
        ],
        tags: [
            "wip"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "⚓",
        description: "anchor",
        category: "Travel & Places",
        aliases: [
            "anchor"
        ],
        tags: [
            "ship"
        ],
        unicodeVersion: "4.1",
        iosVersion: "6.0"
    },
    {
        emoji: "⛵",
        description: "sailboat",
        category: "Travel & Places",
        aliases: [
            "boat",
            "sailboat"
        ],
        tags: [],
        unicodeVersion: "5.2",
        iosVersion: "6.0"
    },
    {
        emoji: "🛶",
        description: "canoe",
        category: "Travel & Places",
        aliases: [
            "canoe"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🚤",
        description: "speedboat",
        category: "Travel & Places",
        aliases: [
            "speedboat"
        ],
        tags: [
            "ship"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🛳️",
        description: "passenger ship",
        category: "Travel & Places",
        aliases: [
            "passenger_ship"
        ],
        tags: [
            "cruise"
        ],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "⛴️",
        description: "ferry",
        category: "Travel & Places",
        aliases: [
            "ferry"
        ],
        tags: [],
        unicodeVersion: "5.2",
        iosVersion: "9.1"
    },
    {
        emoji: "🛥️",
        description: "motor boat",
        category: "Travel & Places",
        aliases: [
            "motor_boat"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🚢",
        description: "ship",
        category: "Travel & Places",
        aliases: [
            "ship"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "✈️",
        description: "airplane",
        category: "Travel & Places",
        aliases: [
            "airplane"
        ],
        tags: [
            "flight"
        ],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "🛩️",
        description: "small airplane",
        category: "Travel & Places",
        aliases: [
            "small_airplane"
        ],
        tags: [
            "flight"
        ],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🛫",
        description: "airplane departure",
        category: "Travel & Places",
        aliases: [
            "flight_departure"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🛬",
        description: "airplane arrival",
        category: "Travel & Places",
        aliases: [
            "flight_arrival"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🪂",
        description: "parachute",
        category: "Travel & Places",
        aliases: [
            "parachute"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "💺",
        description: "seat",
        category: "Travel & Places",
        aliases: [
            "seat"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚁",
        description: "helicopter",
        category: "Travel & Places",
        aliases: [
            "helicopter"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚟",
        description: "suspension railway",
        category: "Travel & Places",
        aliases: [
            "suspension_railway"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚠",
        description: "mountain cableway",
        category: "Travel & Places",
        aliases: [
            "mountain_cableway"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚡",
        description: "aerial tramway",
        category: "Travel & Places",
        aliases: [
            "aerial_tramway"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🛰️",
        description: "satellite",
        category: "Travel & Places",
        aliases: [
            "artificial_satellite"
        ],
        tags: [
            "orbit",
            "space"
        ],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🚀",
        description: "rocket",
        category: "Travel & Places",
        aliases: [
            "rocket"
        ],
        tags: [
            "ship",
            "launch"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🛸",
        description: "flying saucer",
        category: "Travel & Places",
        aliases: [
            "flying_saucer"
        ],
        tags: [
            "ufo"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🛎️",
        description: "bellhop bell",
        category: "Travel & Places",
        aliases: [
            "bellhop_bell"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🧳",
        description: "luggage",
        category: "Travel & Places",
        aliases: [
            "luggage"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "⌛",
        description: "hourglass done",
        category: "Travel & Places",
        aliases: [
            "hourglass"
        ],
        tags: [
            "time"
        ],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "⏳",
        description: "hourglass not done",
        category: "Travel & Places",
        aliases: [
            "hourglass_flowing_sand"
        ],
        tags: [
            "time"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "⌚",
        description: "watch",
        category: "Travel & Places",
        aliases: [
            "watch"
        ],
        tags: [
            "time"
        ],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "⏰",
        description: "alarm clock",
        category: "Travel & Places",
        aliases: [
            "alarm_clock"
        ],
        tags: [
            "morning"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "⏱️",
        description: "stopwatch",
        category: "Travel & Places",
        aliases: [
            "stopwatch"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.1"
    },
    {
        emoji: "⏲️",
        description: "timer clock",
        category: "Travel & Places",
        aliases: [
            "timer_clock"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🕰️",
        description: "mantelpiece clock",
        category: "Travel & Places",
        aliases: [
            "mantelpiece_clock"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🕛",
        description: "twelve o’clock",
        category: "Travel & Places",
        aliases: [
            "clock12"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🕧",
        description: "twelve-thirty",
        category: "Travel & Places",
        aliases: [
            "clock1230"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🕐",
        description: "one o’clock",
        category: "Travel & Places",
        aliases: [
            "clock1"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🕜",
        description: "one-thirty",
        category: "Travel & Places",
        aliases: [
            "clock130"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🕑",
        description: "two o’clock",
        category: "Travel & Places",
        aliases: [
            "clock2"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🕝",
        description: "two-thirty",
        category: "Travel & Places",
        aliases: [
            "clock230"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🕒",
        description: "three o’clock",
        category: "Travel & Places",
        aliases: [
            "clock3"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🕞",
        description: "three-thirty",
        category: "Travel & Places",
        aliases: [
            "clock330"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🕓",
        description: "four o’clock",
        category: "Travel & Places",
        aliases: [
            "clock4"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🕟",
        description: "four-thirty",
        category: "Travel & Places",
        aliases: [
            "clock430"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🕔",
        description: "five o’clock",
        category: "Travel & Places",
        aliases: [
            "clock5"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🕠",
        description: "five-thirty",
        category: "Travel & Places",
        aliases: [
            "clock530"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🕕",
        description: "six o’clock",
        category: "Travel & Places",
        aliases: [
            "clock6"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🕡",
        description: "six-thirty",
        category: "Travel & Places",
        aliases: [
            "clock630"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🕖",
        description: "seven o’clock",
        category: "Travel & Places",
        aliases: [
            "clock7"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🕢",
        description: "seven-thirty",
        category: "Travel & Places",
        aliases: [
            "clock730"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🕗",
        description: "eight o’clock",
        category: "Travel & Places",
        aliases: [
            "clock8"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🕣",
        description: "eight-thirty",
        category: "Travel & Places",
        aliases: [
            "clock830"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🕘",
        description: "nine o’clock",
        category: "Travel & Places",
        aliases: [
            "clock9"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🕤",
        description: "nine-thirty",
        category: "Travel & Places",
        aliases: [
            "clock930"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🕙",
        description: "ten o’clock",
        category: "Travel & Places",
        aliases: [
            "clock10"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🕥",
        description: "ten-thirty",
        category: "Travel & Places",
        aliases: [
            "clock1030"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🕚",
        description: "eleven o’clock",
        category: "Travel & Places",
        aliases: [
            "clock11"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🕦",
        description: "eleven-thirty",
        category: "Travel & Places",
        aliases: [
            "clock1130"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌑",
        description: "new moon",
        category: "Travel & Places",
        aliases: [
            "new_moon"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌒",
        description: "waxing crescent moon",
        category: "Travel & Places",
        aliases: [
            "waxing_crescent_moon"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌓",
        description: "first quarter moon",
        category: "Travel & Places",
        aliases: [
            "first_quarter_moon"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌔",
        description: "waxing gibbous moon",
        category: "Travel & Places",
        aliases: [
            "moon",
            "waxing_gibbous_moon"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌕",
        description: "full moon",
        category: "Travel & Places",
        aliases: [
            "full_moon"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌖",
        description: "waning gibbous moon",
        category: "Travel & Places",
        aliases: [
            "waning_gibbous_moon"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌗",
        description: "last quarter moon",
        category: "Travel & Places",
        aliases: [
            "last_quarter_moon"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌘",
        description: "waning crescent moon",
        category: "Travel & Places",
        aliases: [
            "waning_crescent_moon"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌙",
        description: "crescent moon",
        category: "Travel & Places",
        aliases: [
            "crescent_moon"
        ],
        tags: [
            "night"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌚",
        description: "new moon face",
        category: "Travel & Places",
        aliases: [
            "new_moon_with_face"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌛",
        description: "first quarter moon face",
        category: "Travel & Places",
        aliases: [
            "first_quarter_moon_with_face"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌜",
        description: "last quarter moon face",
        category: "Travel & Places",
        aliases: [
            "last_quarter_moon_with_face"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌡️",
        description: "thermometer",
        category: "Travel & Places",
        aliases: [
            "thermometer"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "☀️",
        description: "sun",
        category: "Travel & Places",
        aliases: [
            "sunny"
        ],
        tags: [
            "weather"
        ],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "🌝",
        description: "full moon face",
        category: "Travel & Places",
        aliases: [
            "full_moon_with_face"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌞",
        description: "sun with face",
        category: "Travel & Places",
        aliases: [
            "sun_with_face"
        ],
        tags: [
            "summer"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🪐",
        description: "ringed planet",
        category: "Travel & Places",
        aliases: [
            "ringed_planet"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "⭐",
        description: "star",
        category: "Travel & Places",
        aliases: [
            "star"
        ],
        tags: [],
        unicodeVersion: "5.1",
        iosVersion: "6.0"
    },
    {
        emoji: "🌟",
        description: "glowing star",
        category: "Travel & Places",
        aliases: [
            "star2"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌠",
        description: "shooting star",
        category: "Travel & Places",
        aliases: [
            "stars"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌌",
        description: "milky way",
        category: "Travel & Places",
        aliases: [
            "milky_way"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "☁️",
        description: "cloud",
        category: "Travel & Places",
        aliases: [
            "cloud"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "⛅",
        description: "sun behind cloud",
        category: "Travel & Places",
        aliases: [
            "partly_sunny"
        ],
        tags: [
            "weather",
            "cloud"
        ],
        unicodeVersion: "5.2",
        iosVersion: "6.0"
    },
    {
        emoji: "⛈️",
        description: "cloud with lightning and rain",
        category: "Travel & Places",
        aliases: [
            "cloud_with_lightning_and_rain"
        ],
        tags: [],
        unicodeVersion: "5.2",
        iosVersion: "9.1"
    },
    {
        emoji: "🌤️",
        description: "sun behind small cloud",
        category: "Travel & Places",
        aliases: [
            "sun_behind_small_cloud"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🌥️",
        description: "sun behind large cloud",
        category: "Travel & Places",
        aliases: [
            "sun_behind_large_cloud"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🌦️",
        description: "sun behind rain cloud",
        category: "Travel & Places",
        aliases: [
            "sun_behind_rain_cloud"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🌧️",
        description: "cloud with rain",
        category: "Travel & Places",
        aliases: [
            "cloud_with_rain"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🌨️",
        description: "cloud with snow",
        category: "Travel & Places",
        aliases: [
            "cloud_with_snow"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🌩️",
        description: "cloud with lightning",
        category: "Travel & Places",
        aliases: [
            "cloud_with_lightning"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🌪️",
        description: "tornado",
        category: "Travel & Places",
        aliases: [
            "tornado"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🌫️",
        description: "fog",
        category: "Travel & Places",
        aliases: [
            "fog"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🌬️",
        description: "wind face",
        category: "Travel & Places",
        aliases: [
            "wind_face"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🌀",
        description: "cyclone",
        category: "Travel & Places",
        aliases: [
            "cyclone"
        ],
        tags: [
            "swirl"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌈",
        description: "rainbow",
        category: "Travel & Places",
        aliases: [
            "rainbow"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌂",
        description: "closed umbrella",
        category: "Travel & Places",
        aliases: [
            "closed_umbrella"
        ],
        tags: [
            "weather",
            "rain"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "☂️",
        description: "umbrella",
        category: "Travel & Places",
        aliases: [
            "open_umbrella"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "9.1"
    },
    {
        emoji: "☔",
        description: "umbrella with rain drops",
        category: "Travel & Places",
        aliases: [
            "umbrella"
        ],
        tags: [
            "rain",
            "weather"
        ],
        unicodeVersion: "4.0",
        iosVersion: "6.0"
    },
    {
        emoji: "⛱️",
        description: "umbrella on ground",
        category: "Travel & Places",
        aliases: [
            "parasol_on_ground"
        ],
        tags: [
            "beach_umbrella"
        ],
        unicodeVersion: "5.2",
        iosVersion: "9.1"
    },
    {
        emoji: "⚡",
        description: "high voltage",
        category: "Travel & Places",
        aliases: [
            "zap"
        ],
        tags: [
            "lightning",
            "thunder"
        ],
        unicodeVersion: "4.0",
        iosVersion: "6.0"
    },
    {
        emoji: "❄️",
        description: "snowflake",
        category: "Travel & Places",
        aliases: [
            "snowflake"
        ],
        tags: [
            "winter",
            "cold",
            "weather"
        ],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "☃️",
        description: "snowman",
        category: "Travel & Places",
        aliases: [
            "snowman_with_snow"
        ],
        tags: [
            "winter",
            "christmas"
        ],
        unicodeVersion: "",
        iosVersion: "9.1"
    },
    {
        emoji: "⛄",
        description: "snowman without snow",
        category: "Travel & Places",
        aliases: [
            "snowman"
        ],
        tags: [
            "winter"
        ],
        unicodeVersion: "5.2",
        iosVersion: "6.0"
    },
    {
        emoji: "☄️",
        description: "comet",
        category: "Travel & Places",
        aliases: [
            "comet"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "9.1"
    },
    {
        emoji: "🔥",
        description: "fire",
        category: "Travel & Places",
        aliases: [
            "fire"
        ],
        tags: [
            "burn"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💧",
        description: "droplet",
        category: "Travel & Places",
        aliases: [
            "droplet"
        ],
        tags: [
            "water"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🌊",
        description: "water wave",
        category: "Travel & Places",
        aliases: [
            "ocean"
        ],
        tags: [
            "sea"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🎃",
        description: "jack-o-lantern",
        category: "Activities",
        aliases: [
            "jack_o_lantern"
        ],
        tags: [
            "halloween"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🎄",
        description: "Christmas tree",
        category: "Activities",
        aliases: [
            "christmas_tree"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🎆",
        description: "fireworks",
        category: "Activities",
        aliases: [
            "fireworks"
        ],
        tags: [
            "festival",
            "celebration"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🎇",
        description: "sparkler",
        category: "Activities",
        aliases: [
            "sparkler"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🧨",
        description: "firecracker",
        category: "Activities",
        aliases: [
            "firecracker"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "✨",
        description: "sparkles",
        category: "Activities",
        aliases: [
            "sparkles"
        ],
        tags: [
            "shiny"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🎈",
        description: "balloon",
        category: "Activities",
        aliases: [
            "balloon"
        ],
        tags: [
            "party",
            "birthday"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🎉",
        description: "party popper",
        category: "Activities",
        aliases: [
            "tada"
        ],
        tags: [
            "hooray",
            "party"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🎊",
        description: "confetti ball",
        category: "Activities",
        aliases: [
            "confetti_ball"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🎋",
        description: "tanabata tree",
        category: "Activities",
        aliases: [
            "tanabata_tree"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🎍",
        description: "pine decoration",
        category: "Activities",
        aliases: [
            "bamboo"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🎎",
        description: "Japanese dolls",
        category: "Activities",
        aliases: [
            "dolls"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🎏",
        description: "carp streamer",
        category: "Activities",
        aliases: [
            "flags"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🎐",
        description: "wind chime",
        category: "Activities",
        aliases: [
            "wind_chime"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🎑",
        description: "moon viewing ceremony",
        category: "Activities",
        aliases: [
            "rice_scene"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🧧",
        description: "red envelope",
        category: "Activities",
        aliases: [
            "red_envelope"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🎀",
        description: "ribbon",
        category: "Activities",
        aliases: [
            "ribbon"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🎁",
        description: "wrapped gift",
        category: "Activities",
        aliases: [
            "gift"
        ],
        tags: [
            "present",
            "birthday",
            "christmas"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🎗️",
        description: "reminder ribbon",
        category: "Activities",
        aliases: [
            "reminder_ribbon"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🎟️",
        description: "admission tickets",
        category: "Activities",
        aliases: [
            "tickets"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🎫",
        description: "ticket",
        category: "Activities",
        aliases: [
            "ticket"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🎖️",
        description: "military medal",
        category: "Activities",
        aliases: [
            "medal_military"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🏆",
        description: "trophy",
        category: "Activities",
        aliases: [
            "trophy"
        ],
        tags: [
            "award",
            "contest",
            "winner"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🏅",
        description: "sports medal",
        category: "Activities",
        aliases: [
            "medal_sports"
        ],
        tags: [
            "gold",
            "winner"
        ],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🥇",
        description: "1st place medal",
        category: "Activities",
        aliases: [
            "1st_place_medal"
        ],
        tags: [
            "gold"
        ],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🥈",
        description: "2nd place medal",
        category: "Activities",
        aliases: [
            "2nd_place_medal"
        ],
        tags: [
            "silver"
        ],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🥉",
        description: "3rd place medal",
        category: "Activities",
        aliases: [
            "3rd_place_medal"
        ],
        tags: [
            "bronze"
        ],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "⚽",
        description: "soccer ball",
        category: "Activities",
        aliases: [
            "soccer"
        ],
        tags: [
            "sports"
        ],
        unicodeVersion: "5.2",
        iosVersion: "6.0"
    },
    {
        emoji: "⚾",
        description: "baseball",
        category: "Activities",
        aliases: [
            "baseball"
        ],
        tags: [
            "sports"
        ],
        unicodeVersion: "5.2",
        iosVersion: "6.0"
    },
    {
        emoji: "🥎",
        description: "softball",
        category: "Activities",
        aliases: [
            "softball"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🏀",
        description: "basketball",
        category: "Activities",
        aliases: [
            "basketball"
        ],
        tags: [
            "sports"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🏐",
        description: "volleyball",
        category: "Activities",
        aliases: [
            "volleyball"
        ],
        tags: [],
        unicodeVersion: "8.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🏈",
        description: "american football",
        category: "Activities",
        aliases: [
            "football"
        ],
        tags: [
            "sports"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🏉",
        description: "rugby football",
        category: "Activities",
        aliases: [
            "rugby_football"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🎾",
        description: "tennis",
        category: "Activities",
        aliases: [
            "tennis"
        ],
        tags: [
            "sports"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🥏",
        description: "flying disc",
        category: "Activities",
        aliases: [
            "flying_disc"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🎳",
        description: "bowling",
        category: "Activities",
        aliases: [
            "bowling"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🏏",
        description: "cricket game",
        category: "Activities",
        aliases: [
            "cricket_game"
        ],
        tags: [],
        unicodeVersion: "8.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🏑",
        description: "field hockey",
        category: "Activities",
        aliases: [
            "field_hockey"
        ],
        tags: [],
        unicodeVersion: "8.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🏒",
        description: "ice hockey",
        category: "Activities",
        aliases: [
            "ice_hockey"
        ],
        tags: [],
        unicodeVersion: "8.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🥍",
        description: "lacrosse",
        category: "Activities",
        aliases: [
            "lacrosse"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🏓",
        description: "ping pong",
        category: "Activities",
        aliases: [
            "ping_pong"
        ],
        tags: [],
        unicodeVersion: "8.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🏸",
        description: "badminton",
        category: "Activities",
        aliases: [
            "badminton"
        ],
        tags: [],
        unicodeVersion: "8.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🥊",
        description: "boxing glove",
        category: "Activities",
        aliases: [
            "boxing_glove"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🥋",
        description: "martial arts uniform",
        category: "Activities",
        aliases: [
            "martial_arts_uniform"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🥅",
        description: "goal net",
        category: "Activities",
        aliases: [
            "goal_net"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "⛳",
        description: "flag in hole",
        category: "Activities",
        aliases: [
            "golf"
        ],
        tags: [],
        unicodeVersion: "5.2",
        iosVersion: "6.0"
    },
    {
        emoji: "⛸️",
        description: "ice skate",
        category: "Activities",
        aliases: [
            "ice_skate"
        ],
        tags: [
            "skating"
        ],
        unicodeVersion: "5.2",
        iosVersion: "9.1"
    },
    {
        emoji: "🎣",
        description: "fishing pole",
        category: "Activities",
        aliases: [
            "fishing_pole_and_fish"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🤿",
        description: "diving mask",
        category: "Activities",
        aliases: [
            "diving_mask"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🎽",
        description: "running shirt",
        category: "Activities",
        aliases: [
            "running_shirt_with_sash"
        ],
        tags: [
            "marathon"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🎿",
        description: "skis",
        category: "Activities",
        aliases: [
            "ski"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🛷",
        description: "sled",
        category: "Activities",
        aliases: [
            "sled"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🥌",
        description: "curling stone",
        category: "Activities",
        aliases: [
            "curling_stone"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🎯",
        description: "direct hit",
        category: "Activities",
        aliases: [
            "dart"
        ],
        tags: [
            "target"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🪀",
        description: "yo-yo",
        category: "Activities",
        aliases: [
            "yo_yo"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🪁",
        description: "kite",
        category: "Activities",
        aliases: [
            "kite"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🎱",
        description: "pool 8 ball",
        category: "Activities",
        aliases: [
            "8ball"
        ],
        tags: [
            "pool",
            "billiards"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔮",
        description: "crystal ball",
        category: "Activities",
        aliases: [
            "crystal_ball"
        ],
        tags: [
            "fortune"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🪄",
        description: "magic wand",
        category: "Activities",
        aliases: [
            "magic_wand"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🧿",
        description: "nazar amulet",
        category: "Activities",
        aliases: [
            "nazar_amulet"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🎮",
        description: "video game",
        category: "Activities",
        aliases: [
            "video_game"
        ],
        tags: [
            "play",
            "controller",
            "console"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🕹️",
        description: "joystick",
        category: "Activities",
        aliases: [
            "joystick"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🎰",
        description: "slot machine",
        category: "Activities",
        aliases: [
            "slot_machine"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🎲",
        description: "game die",
        category: "Activities",
        aliases: [
            "game_die"
        ],
        tags: [
            "dice",
            "gambling"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🧩",
        description: "puzzle piece",
        category: "Activities",
        aliases: [
            "jigsaw"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🧸",
        description: "teddy bear",
        category: "Activities",
        aliases: [
            "teddy_bear"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🪅",
        description: "piñata",
        category: "Activities",
        aliases: [
            "pinata"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🪆",
        description: "nesting dolls",
        category: "Activities",
        aliases: [
            "nesting_dolls"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "♠️",
        description: "spade suit",
        category: "Activities",
        aliases: [
            "spades"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "♥️",
        description: "heart suit",
        category: "Activities",
        aliases: [
            "hearts"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "♦️",
        description: "diamond suit",
        category: "Activities",
        aliases: [
            "diamonds"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "♣️",
        description: "club suit",
        category: "Activities",
        aliases: [
            "clubs"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "♟️",
        description: "chess pawn",
        category: "Activities",
        aliases: [
            "chess_pawn"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🃏",
        description: "joker",
        category: "Activities",
        aliases: [
            "black_joker"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🀄",
        description: "mahjong red dragon",
        category: "Activities",
        aliases: [
            "mahjong"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "🎴",
        description: "flower playing cards",
        category: "Activities",
        aliases: [
            "flower_playing_cards"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🎭",
        description: "performing arts",
        category: "Activities",
        aliases: [
            "performing_arts"
        ],
        tags: [
            "theater",
            "drama"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🖼️",
        description: "framed picture",
        category: "Activities",
        aliases: [
            "framed_picture"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🎨",
        description: "artist palette",
        category: "Activities",
        aliases: [
            "art"
        ],
        tags: [
            "design",
            "paint"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🧵",
        description: "thread",
        category: "Activities",
        aliases: [
            "thread"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🪡",
        description: "sewing needle",
        category: "Activities",
        aliases: [
            "sewing_needle"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🧶",
        description: "yarn",
        category: "Activities",
        aliases: [
            "yarn"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🪢",
        description: "knot",
        category: "Activities",
        aliases: [
            "knot"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "👓",
        description: "glasses",
        category: "Objects",
        aliases: [
            "eyeglasses"
        ],
        tags: [
            "glasses"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🕶️",
        description: "sunglasses",
        category: "Objects",
        aliases: [
            "dark_sunglasses"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🥽",
        description: "goggles",
        category: "Objects",
        aliases: [
            "goggles"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🥼",
        description: "lab coat",
        category: "Objects",
        aliases: [
            "lab_coat"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🦺",
        description: "safety vest",
        category: "Objects",
        aliases: [
            "safety_vest"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "👔",
        description: "necktie",
        category: "Objects",
        aliases: [
            "necktie"
        ],
        tags: [
            "shirt",
            "formal"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "👕",
        description: "t-shirt",
        category: "Objects",
        aliases: [
            "shirt",
            "tshirt"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "👖",
        description: "jeans",
        category: "Objects",
        aliases: [
            "jeans"
        ],
        tags: [
            "pants"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🧣",
        description: "scarf",
        category: "Objects",
        aliases: [
            "scarf"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🧤",
        description: "gloves",
        category: "Objects",
        aliases: [
            "gloves"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🧥",
        description: "coat",
        category: "Objects",
        aliases: [
            "coat"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🧦",
        description: "socks",
        category: "Objects",
        aliases: [
            "socks"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "👗",
        description: "dress",
        category: "Objects",
        aliases: [
            "dress"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "👘",
        description: "kimono",
        category: "Objects",
        aliases: [
            "kimono"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🥻",
        description: "sari",
        category: "Objects",
        aliases: [
            "sari"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🩱",
        description: "one-piece swimsuit",
        category: "Objects",
        aliases: [
            "one_piece_swimsuit"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🩲",
        description: "briefs",
        category: "Objects",
        aliases: [
            "swim_brief"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🩳",
        description: "shorts",
        category: "Objects",
        aliases: [
            "shorts"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "👙",
        description: "bikini",
        category: "Objects",
        aliases: [
            "bikini"
        ],
        tags: [
            "beach"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "👚",
        description: "woman’s clothes",
        category: "Objects",
        aliases: [
            "womans_clothes"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "👛",
        description: "purse",
        category: "Objects",
        aliases: [
            "purse"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "👜",
        description: "handbag",
        category: "Objects",
        aliases: [
            "handbag"
        ],
        tags: [
            "bag"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "👝",
        description: "clutch bag",
        category: "Objects",
        aliases: [
            "pouch"
        ],
        tags: [
            "bag"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🛍️",
        description: "shopping bags",
        category: "Objects",
        aliases: [
            "shopping"
        ],
        tags: [
            "bags"
        ],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🎒",
        description: "backpack",
        category: "Objects",
        aliases: [
            "school_satchel"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🩴",
        description: "thong sandal",
        category: "Objects",
        aliases: [
            "thong_sandal"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "👞",
        description: "man’s shoe",
        category: "Objects",
        aliases: [
            "mans_shoe",
            "shoe"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "👟",
        description: "running shoe",
        category: "Objects",
        aliases: [
            "athletic_shoe"
        ],
        tags: [
            "sneaker",
            "sport",
            "running"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🥾",
        description: "hiking boot",
        category: "Objects",
        aliases: [
            "hiking_boot"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🥿",
        description: "flat shoe",
        category: "Objects",
        aliases: [
            "flat_shoe"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "👠",
        description: "high-heeled shoe",
        category: "Objects",
        aliases: [
            "high_heel"
        ],
        tags: [
            "shoe"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "👡",
        description: "woman’s sandal",
        category: "Objects",
        aliases: [
            "sandal"
        ],
        tags: [
            "shoe"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🩰",
        description: "ballet shoes",
        category: "Objects",
        aliases: [
            "ballet_shoes"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "👢",
        description: "woman’s boot",
        category: "Objects",
        aliases: [
            "boot"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "👑",
        description: "crown",
        category: "Objects",
        aliases: [
            "crown"
        ],
        tags: [
            "king",
            "queen",
            "royal"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "👒",
        description: "woman’s hat",
        category: "Objects",
        aliases: [
            "womans_hat"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🎩",
        description: "top hat",
        category: "Objects",
        aliases: [
            "tophat"
        ],
        tags: [
            "hat",
            "classy"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🎓",
        description: "graduation cap",
        category: "Objects",
        aliases: [
            "mortar_board"
        ],
        tags: [
            "education",
            "college",
            "university",
            "graduation"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🧢",
        description: "billed cap",
        category: "Objects",
        aliases: [
            "billed_cap"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🪖",
        description: "military helmet",
        category: "Objects",
        aliases: [
            "military_helmet"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "⛑️",
        description: "rescue worker’s helmet",
        category: "Objects",
        aliases: [
            "rescue_worker_helmet"
        ],
        tags: [],
        unicodeVersion: "5.2",
        iosVersion: "9.1"
    },
    {
        emoji: "📿",
        description: "prayer beads",
        category: "Objects",
        aliases: [
            "prayer_beads"
        ],
        tags: [],
        unicodeVersion: "8.0",
        iosVersion: "9.1"
    },
    {
        emoji: "💄",
        description: "lipstick",
        category: "Objects",
        aliases: [
            "lipstick"
        ],
        tags: [
            "makeup"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💍",
        description: "ring",
        category: "Objects",
        aliases: [
            "ring"
        ],
        tags: [
            "wedding",
            "marriage",
            "engaged"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💎",
        description: "gem stone",
        category: "Objects",
        aliases: [
            "gem"
        ],
        tags: [
            "diamond"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔇",
        description: "muted speaker",
        category: "Objects",
        aliases: [
            "mute"
        ],
        tags: [
            "sound",
            "volume"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔈",
        description: "speaker low volume",
        category: "Objects",
        aliases: [
            "speaker"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔉",
        description: "speaker medium volume",
        category: "Objects",
        aliases: [
            "sound"
        ],
        tags: [
            "volume"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔊",
        description: "speaker high volume",
        category: "Objects",
        aliases: [
            "loud_sound"
        ],
        tags: [
            "volume"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📢",
        description: "loudspeaker",
        category: "Objects",
        aliases: [
            "loudspeaker"
        ],
        tags: [
            "announcement"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📣",
        description: "megaphone",
        category: "Objects",
        aliases: [
            "mega"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📯",
        description: "postal horn",
        category: "Objects",
        aliases: [
            "postal_horn"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔔",
        description: "bell",
        category: "Objects",
        aliases: [
            "bell"
        ],
        tags: [
            "sound",
            "notification"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔕",
        description: "bell with slash",
        category: "Objects",
        aliases: [
            "no_bell"
        ],
        tags: [
            "volume",
            "off"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🎼",
        description: "musical score",
        category: "Objects",
        aliases: [
            "musical_score"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🎵",
        description: "musical note",
        category: "Objects",
        aliases: [
            "musical_note"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🎶",
        description: "musical notes",
        category: "Objects",
        aliases: [
            "notes"
        ],
        tags: [
            "music"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🎙️",
        description: "studio microphone",
        category: "Objects",
        aliases: [
            "studio_microphone"
        ],
        tags: [
            "podcast"
        ],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🎚️",
        description: "level slider",
        category: "Objects",
        aliases: [
            "level_slider"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🎛️",
        description: "control knobs",
        category: "Objects",
        aliases: [
            "control_knobs"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🎤",
        description: "microphone",
        category: "Objects",
        aliases: [
            "microphone"
        ],
        tags: [
            "sing"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🎧",
        description: "headphone",
        category: "Objects",
        aliases: [
            "headphones"
        ],
        tags: [
            "music",
            "earphones"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📻",
        description: "radio",
        category: "Objects",
        aliases: [
            "radio"
        ],
        tags: [
            "podcast"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🎷",
        description: "saxophone",
        category: "Objects",
        aliases: [
            "saxophone"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🪗",
        description: "accordion",
        category: "Objects",
        aliases: [
            "accordion"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🎸",
        description: "guitar",
        category: "Objects",
        aliases: [
            "guitar"
        ],
        tags: [
            "rock"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🎹",
        description: "musical keyboard",
        category: "Objects",
        aliases: [
            "musical_keyboard"
        ],
        tags: [
            "piano"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🎺",
        description: "trumpet",
        category: "Objects",
        aliases: [
            "trumpet"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🎻",
        description: "violin",
        category: "Objects",
        aliases: [
            "violin"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🪕",
        description: "banjo",
        category: "Objects",
        aliases: [
            "banjo"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🥁",
        description: "drum",
        category: "Objects",
        aliases: [
            "drum"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "10.2"
    },
    {
        emoji: "🪘",
        description: "long drum",
        category: "Objects",
        aliases: [
            "long_drum"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "📱",
        description: "mobile phone",
        category: "Objects",
        aliases: [
            "iphone"
        ],
        tags: [
            "smartphone",
            "mobile"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📲",
        description: "mobile phone with arrow",
        category: "Objects",
        aliases: [
            "calling"
        ],
        tags: [
            "call",
            "incoming"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "☎️",
        description: "telephone",
        category: "Objects",
        aliases: [
            "phone",
            "telephone"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "📞",
        description: "telephone receiver",
        category: "Objects",
        aliases: [
            "telephone_receiver"
        ],
        tags: [
            "phone",
            "call"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📟",
        description: "pager",
        category: "Objects",
        aliases: [
            "pager"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📠",
        description: "fax machine",
        category: "Objects",
        aliases: [
            "fax"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔋",
        description: "battery",
        category: "Objects",
        aliases: [
            "battery"
        ],
        tags: [
            "power"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔌",
        description: "electric plug",
        category: "Objects",
        aliases: [
            "electric_plug"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💻",
        description: "laptop",
        category: "Objects",
        aliases: [
            "computer"
        ],
        tags: [
            "desktop",
            "screen"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🖥️",
        description: "desktop computer",
        category: "Objects",
        aliases: [
            "desktop_computer"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🖨️",
        description: "printer",
        category: "Objects",
        aliases: [
            "printer"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "⌨️",
        description: "keyboard",
        category: "Objects",
        aliases: [
            "keyboard"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "9.1"
    },
    {
        emoji: "🖱️",
        description: "computer mouse",
        category: "Objects",
        aliases: [
            "computer_mouse"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🖲️",
        description: "trackball",
        category: "Objects",
        aliases: [
            "trackball"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "💽",
        description: "computer disk",
        category: "Objects",
        aliases: [
            "minidisc"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💾",
        description: "floppy disk",
        category: "Objects",
        aliases: [
            "floppy_disk"
        ],
        tags: [
            "save"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💿",
        description: "optical disk",
        category: "Objects",
        aliases: [
            "cd"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📀",
        description: "dvd",
        category: "Objects",
        aliases: [
            "dvd"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🧮",
        description: "abacus",
        category: "Objects",
        aliases: [
            "abacus"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🎥",
        description: "movie camera",
        category: "Objects",
        aliases: [
            "movie_camera"
        ],
        tags: [
            "film",
            "video"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🎞️",
        description: "film frames",
        category: "Objects",
        aliases: [
            "film_strip"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "📽️",
        description: "film projector",
        category: "Objects",
        aliases: [
            "film_projector"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🎬",
        description: "clapper board",
        category: "Objects",
        aliases: [
            "clapper"
        ],
        tags: [
            "film"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📺",
        description: "television",
        category: "Objects",
        aliases: [
            "tv"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📷",
        description: "camera",
        category: "Objects",
        aliases: [
            "camera"
        ],
        tags: [
            "photo"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📸",
        description: "camera with flash",
        category: "Objects",
        aliases: [
            "camera_flash"
        ],
        tags: [
            "photo"
        ],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "📹",
        description: "video camera",
        category: "Objects",
        aliases: [
            "video_camera"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📼",
        description: "videocassette",
        category: "Objects",
        aliases: [
            "vhs"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔍",
        description: "magnifying glass tilted left",
        category: "Objects",
        aliases: [
            "mag"
        ],
        tags: [
            "search",
            "zoom"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔎",
        description: "magnifying glass tilted right",
        category: "Objects",
        aliases: [
            "mag_right"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🕯️",
        description: "candle",
        category: "Objects",
        aliases: [
            "candle"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "💡",
        description: "light bulb",
        category: "Objects",
        aliases: [
            "bulb"
        ],
        tags: [
            "idea",
            "light"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔦",
        description: "flashlight",
        category: "Objects",
        aliases: [
            "flashlight"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🏮",
        description: "red paper lantern",
        category: "Objects",
        aliases: [
            "izakaya_lantern",
            "lantern"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🪔",
        description: "diya lamp",
        category: "Objects",
        aliases: [
            "diya_lamp"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "📔",
        description: "notebook with decorative cover",
        category: "Objects",
        aliases: [
            "notebook_with_decorative_cover"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📕",
        description: "closed book",
        category: "Objects",
        aliases: [
            "closed_book"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📖",
        description: "open book",
        category: "Objects",
        aliases: [
            "book",
            "open_book"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📗",
        description: "green book",
        category: "Objects",
        aliases: [
            "green_book"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📘",
        description: "blue book",
        category: "Objects",
        aliases: [
            "blue_book"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📙",
        description: "orange book",
        category: "Objects",
        aliases: [
            "orange_book"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📚",
        description: "books",
        category: "Objects",
        aliases: [
            "books"
        ],
        tags: [
            "library"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📓",
        description: "notebook",
        category: "Objects",
        aliases: [
            "notebook"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📒",
        description: "ledger",
        category: "Objects",
        aliases: [
            "ledger"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📃",
        description: "page with curl",
        category: "Objects",
        aliases: [
            "page_with_curl"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📜",
        description: "scroll",
        category: "Objects",
        aliases: [
            "scroll"
        ],
        tags: [
            "document"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📄",
        description: "page facing up",
        category: "Objects",
        aliases: [
            "page_facing_up"
        ],
        tags: [
            "document"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📰",
        description: "newspaper",
        category: "Objects",
        aliases: [
            "newspaper"
        ],
        tags: [
            "press"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🗞️",
        description: "rolled-up newspaper",
        category: "Objects",
        aliases: [
            "newspaper_roll"
        ],
        tags: [
            "press"
        ],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "📑",
        description: "bookmark tabs",
        category: "Objects",
        aliases: [
            "bookmark_tabs"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔖",
        description: "bookmark",
        category: "Objects",
        aliases: [
            "bookmark"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🏷️",
        description: "label",
        category: "Objects",
        aliases: [
            "label"
        ],
        tags: [
            "tag"
        ],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "💰",
        description: "money bag",
        category: "Objects",
        aliases: [
            "moneybag"
        ],
        tags: [
            "dollar",
            "cream"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🪙",
        description: "coin",
        category: "Objects",
        aliases: [
            "coin"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "💴",
        description: "yen banknote",
        category: "Objects",
        aliases: [
            "yen"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💵",
        description: "dollar banknote",
        category: "Objects",
        aliases: [
            "dollar"
        ],
        tags: [
            "money"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💶",
        description: "euro banknote",
        category: "Objects",
        aliases: [
            "euro"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💷",
        description: "pound banknote",
        category: "Objects",
        aliases: [
            "pound"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💸",
        description: "money with wings",
        category: "Objects",
        aliases: [
            "money_with_wings"
        ],
        tags: [
            "dollar"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💳",
        description: "credit card",
        category: "Objects",
        aliases: [
            "credit_card"
        ],
        tags: [
            "subscription"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🧾",
        description: "receipt",
        category: "Objects",
        aliases: [
            "receipt"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "💹",
        description: "chart increasing with yen",
        category: "Objects",
        aliases: [
            "chart"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "✉️",
        description: "envelope",
        category: "Objects",
        aliases: [
            "email",
            "envelope"
        ],
        tags: [
            "letter"
        ],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "📧",
        description: "e-mail",
        category: "Objects",
        aliases: [
            "e-mail"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📨",
        description: "incoming envelope",
        category: "Objects",
        aliases: [
            "incoming_envelope"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📩",
        description: "envelope with arrow",
        category: "Objects",
        aliases: [
            "envelope_with_arrow"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📤",
        description: "outbox tray",
        category: "Objects",
        aliases: [
            "outbox_tray"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📥",
        description: "inbox tray",
        category: "Objects",
        aliases: [
            "inbox_tray"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📦",
        description: "package",
        category: "Objects",
        aliases: [
            "package"
        ],
        tags: [
            "shipping"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📫",
        description: "closed mailbox with raised flag",
        category: "Objects",
        aliases: [
            "mailbox"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📪",
        description: "closed mailbox with lowered flag",
        category: "Objects",
        aliases: [
            "mailbox_closed"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📬",
        description: "open mailbox with raised flag",
        category: "Objects",
        aliases: [
            "mailbox_with_mail"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📭",
        description: "open mailbox with lowered flag",
        category: "Objects",
        aliases: [
            "mailbox_with_no_mail"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📮",
        description: "postbox",
        category: "Objects",
        aliases: [
            "postbox"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🗳️",
        description: "ballot box with ballot",
        category: "Objects",
        aliases: [
            "ballot_box"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "✏️",
        description: "pencil",
        category: "Objects",
        aliases: [
            "pencil2"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "✒️",
        description: "black nib",
        category: "Objects",
        aliases: [
            "black_nib"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "🖋️",
        description: "fountain pen",
        category: "Objects",
        aliases: [
            "fountain_pen"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🖊️",
        description: "pen",
        category: "Objects",
        aliases: [
            "pen"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🖌️",
        description: "paintbrush",
        category: "Objects",
        aliases: [
            "paintbrush"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🖍️",
        description: "crayon",
        category: "Objects",
        aliases: [
            "crayon"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "📝",
        description: "memo",
        category: "Objects",
        aliases: [
            "memo",
            "pencil"
        ],
        tags: [
            "document",
            "note"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💼",
        description: "briefcase",
        category: "Objects",
        aliases: [
            "briefcase"
        ],
        tags: [
            "business"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📁",
        description: "file folder",
        category: "Objects",
        aliases: [
            "file_folder"
        ],
        tags: [
            "directory"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📂",
        description: "open file folder",
        category: "Objects",
        aliases: [
            "open_file_folder"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🗂️",
        description: "card index dividers",
        category: "Objects",
        aliases: [
            "card_index_dividers"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "📅",
        description: "calendar",
        category: "Objects",
        aliases: [
            "date"
        ],
        tags: [
            "calendar",
            "schedule"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📆",
        description: "tear-off calendar",
        category: "Objects",
        aliases: [
            "calendar"
        ],
        tags: [
            "schedule"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🗒️",
        description: "spiral notepad",
        category: "Objects",
        aliases: [
            "spiral_notepad"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🗓️",
        description: "spiral calendar",
        category: "Objects",
        aliases: [
            "spiral_calendar"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "📇",
        description: "card index",
        category: "Objects",
        aliases: [
            "card_index"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📈",
        description: "chart increasing",
        category: "Objects",
        aliases: [
            "chart_with_upwards_trend"
        ],
        tags: [
            "graph",
            "metrics"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📉",
        description: "chart decreasing",
        category: "Objects",
        aliases: [
            "chart_with_downwards_trend"
        ],
        tags: [
            "graph",
            "metrics"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📊",
        description: "bar chart",
        category: "Objects",
        aliases: [
            "bar_chart"
        ],
        tags: [
            "stats",
            "metrics"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📋",
        description: "clipboard",
        category: "Objects",
        aliases: [
            "clipboard"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📌",
        description: "pushpin",
        category: "Objects",
        aliases: [
            "pushpin"
        ],
        tags: [
            "location"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📍",
        description: "round pushpin",
        category: "Objects",
        aliases: [
            "round_pushpin"
        ],
        tags: [
            "location"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📎",
        description: "paperclip",
        category: "Objects",
        aliases: [
            "paperclip"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🖇️",
        description: "linked paperclips",
        category: "Objects",
        aliases: [
            "paperclips"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "📏",
        description: "straight ruler",
        category: "Objects",
        aliases: [
            "straight_ruler"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📐",
        description: "triangular ruler",
        category: "Objects",
        aliases: [
            "triangular_ruler"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "✂️",
        description: "scissors",
        category: "Objects",
        aliases: [
            "scissors"
        ],
        tags: [
            "cut"
        ],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "🗃️",
        description: "card file box",
        category: "Objects",
        aliases: [
            "card_file_box"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🗄️",
        description: "file cabinet",
        category: "Objects",
        aliases: [
            "file_cabinet"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🗑️",
        description: "wastebasket",
        category: "Objects",
        aliases: [
            "wastebasket"
        ],
        tags: [
            "trash"
        ],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🔒",
        description: "locked",
        category: "Objects",
        aliases: [
            "lock"
        ],
        tags: [
            "security",
            "private"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔓",
        description: "unlocked",
        category: "Objects",
        aliases: [
            "unlock"
        ],
        tags: [
            "security"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔏",
        description: "locked with pen",
        category: "Objects",
        aliases: [
            "lock_with_ink_pen"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔐",
        description: "locked with key",
        category: "Objects",
        aliases: [
            "closed_lock_with_key"
        ],
        tags: [
            "security"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔑",
        description: "key",
        category: "Objects",
        aliases: [
            "key"
        ],
        tags: [
            "lock",
            "password"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🗝️",
        description: "old key",
        category: "Objects",
        aliases: [
            "old_key"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🔨",
        description: "hammer",
        category: "Objects",
        aliases: [
            "hammer"
        ],
        tags: [
            "tool"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🪓",
        description: "axe",
        category: "Objects",
        aliases: [
            "axe"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "⛏️",
        description: "pick",
        category: "Objects",
        aliases: [
            "pick"
        ],
        tags: [],
        unicodeVersion: "5.2",
        iosVersion: "9.1"
    },
    {
        emoji: "⚒️",
        description: "hammer and pick",
        category: "Objects",
        aliases: [
            "hammer_and_pick"
        ],
        tags: [],
        unicodeVersion: "4.1",
        iosVersion: "9.1"
    },
    {
        emoji: "🛠️",
        description: "hammer and wrench",
        category: "Objects",
        aliases: [
            "hammer_and_wrench"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🗡️",
        description: "dagger",
        category: "Objects",
        aliases: [
            "dagger"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "⚔️",
        description: "crossed swords",
        category: "Objects",
        aliases: [
            "crossed_swords"
        ],
        tags: [],
        unicodeVersion: "4.1",
        iosVersion: "9.1"
    },
    {
        emoji: "🔫",
        description: "pistol",
        category: "Objects",
        aliases: [
            "gun"
        ],
        tags: [
            "shoot",
            "weapon"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🪃",
        description: "boomerang",
        category: "Objects",
        aliases: [
            "boomerang"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🏹",
        description: "bow and arrow",
        category: "Objects",
        aliases: [
            "bow_and_arrow"
        ],
        tags: [
            "archery"
        ],
        unicodeVersion: "8.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🛡️",
        description: "shield",
        category: "Objects",
        aliases: [
            "shield"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🪚",
        description: "carpentry saw",
        category: "Objects",
        aliases: [
            "carpentry_saw"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🔧",
        description: "wrench",
        category: "Objects",
        aliases: [
            "wrench"
        ],
        tags: [
            "tool"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🪛",
        description: "screwdriver",
        category: "Objects",
        aliases: [
            "screwdriver"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🔩",
        description: "nut and bolt",
        category: "Objects",
        aliases: [
            "nut_and_bolt"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "⚙️",
        description: "gear",
        category: "Objects",
        aliases: [
            "gear"
        ],
        tags: [],
        unicodeVersion: "4.1",
        iosVersion: "9.1"
    },
    {
        emoji: "🗜️",
        description: "clamp",
        category: "Objects",
        aliases: [
            "clamp"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "⚖️",
        description: "balance scale",
        category: "Objects",
        aliases: [
            "balance_scale"
        ],
        tags: [],
        unicodeVersion: "4.1",
        iosVersion: "9.1"
    },
    {
        emoji: "🦯",
        description: "white cane",
        category: "Objects",
        aliases: [
            "probing_cane"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🔗",
        description: "link",
        category: "Objects",
        aliases: [
            "link"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "⛓️",
        description: "chains",
        category: "Objects",
        aliases: [
            "chains"
        ],
        tags: [],
        unicodeVersion: "5.2",
        iosVersion: "9.1"
    },
    {
        emoji: "🪝",
        description: "hook",
        category: "Objects",
        aliases: [
            "hook"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🧰",
        description: "toolbox",
        category: "Objects",
        aliases: [
            "toolbox"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🧲",
        description: "magnet",
        category: "Objects",
        aliases: [
            "magnet"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🪜",
        description: "ladder",
        category: "Objects",
        aliases: [
            "ladder"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "⚗️",
        description: "alembic",
        category: "Objects",
        aliases: [
            "alembic"
        ],
        tags: [],
        unicodeVersion: "4.1",
        iosVersion: "9.1"
    },
    {
        emoji: "🧪",
        description: "test tube",
        category: "Objects",
        aliases: [
            "test_tube"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🧫",
        description: "petri dish",
        category: "Objects",
        aliases: [
            "petri_dish"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🧬",
        description: "dna",
        category: "Objects",
        aliases: [
            "dna"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🔬",
        description: "microscope",
        category: "Objects",
        aliases: [
            "microscope"
        ],
        tags: [
            "science",
            "laboratory",
            "investigate"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔭",
        description: "telescope",
        category: "Objects",
        aliases: [
            "telescope"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📡",
        description: "satellite antenna",
        category: "Objects",
        aliases: [
            "satellite"
        ],
        tags: [
            "signal"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💉",
        description: "syringe",
        category: "Objects",
        aliases: [
            "syringe"
        ],
        tags: [
            "health",
            "hospital",
            "needle"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🩸",
        description: "drop of blood",
        category: "Objects",
        aliases: [
            "drop_of_blood"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "💊",
        description: "pill",
        category: "Objects",
        aliases: [
            "pill"
        ],
        tags: [
            "health",
            "medicine"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🩹",
        description: "adhesive bandage",
        category: "Objects",
        aliases: [
            "adhesive_bandage"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🩺",
        description: "stethoscope",
        category: "Objects",
        aliases: [
            "stethoscope"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🚪",
        description: "door",
        category: "Objects",
        aliases: [
            "door"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🛗",
        description: "elevator",
        category: "Objects",
        aliases: [
            "elevator"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🪞",
        description: "mirror",
        category: "Objects",
        aliases: [
            "mirror"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🪟",
        description: "window",
        category: "Objects",
        aliases: [
            "window"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🛏️",
        description: "bed",
        category: "Objects",
        aliases: [
            "bed"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🛋️",
        description: "couch and lamp",
        category: "Objects",
        aliases: [
            "couch_and_lamp"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🪑",
        description: "chair",
        category: "Objects",
        aliases: [
            "chair"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🚽",
        description: "toilet",
        category: "Objects",
        aliases: [
            "toilet"
        ],
        tags: [
            "wc"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🪠",
        description: "plunger",
        category: "Objects",
        aliases: [
            "plunger"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🚿",
        description: "shower",
        category: "Objects",
        aliases: [
            "shower"
        ],
        tags: [
            "bath"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🛁",
        description: "bathtub",
        category: "Objects",
        aliases: [
            "bathtub"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🪤",
        description: "mouse trap",
        category: "Objects",
        aliases: [
            "mouse_trap"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🪒",
        description: "razor",
        category: "Objects",
        aliases: [
            "razor"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🧴",
        description: "lotion bottle",
        category: "Objects",
        aliases: [
            "lotion_bottle"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🧷",
        description: "safety pin",
        category: "Objects",
        aliases: [
            "safety_pin"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🧹",
        description: "broom",
        category: "Objects",
        aliases: [
            "broom"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🧺",
        description: "basket",
        category: "Objects",
        aliases: [
            "basket"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🧻",
        description: "roll of paper",
        category: "Objects",
        aliases: [
            "roll_of_paper"
        ],
        tags: [
            "toilet"
        ],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🪣",
        description: "bucket",
        category: "Objects",
        aliases: [
            "bucket"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🧼",
        description: "soap",
        category: "Objects",
        aliases: [
            "soap"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🪥",
        description: "toothbrush",
        category: "Objects",
        aliases: [
            "toothbrush"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🧽",
        description: "sponge",
        category: "Objects",
        aliases: [
            "sponge"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🧯",
        description: "fire extinguisher",
        category: "Objects",
        aliases: [
            "fire_extinguisher"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🛒",
        description: "shopping cart",
        category: "Objects",
        aliases: [
            "shopping_cart"
        ],
        tags: [],
        unicodeVersion: "9.0",
        iosVersion: "10.2"
    },
    {
        emoji: "🚬",
        description: "cigarette",
        category: "Objects",
        aliases: [
            "smoking"
        ],
        tags: [
            "cigarette"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "⚰️",
        description: "coffin",
        category: "Objects",
        aliases: [
            "coffin"
        ],
        tags: [
            "funeral"
        ],
        unicodeVersion: "4.1",
        iosVersion: "9.1"
    },
    {
        emoji: "🪦",
        description: "headstone",
        category: "Objects",
        aliases: [
            "headstone"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "⚱️",
        description: "funeral urn",
        category: "Objects",
        aliases: [
            "funeral_urn"
        ],
        tags: [],
        unicodeVersion: "4.1",
        iosVersion: "9.1"
    },
    {
        emoji: "🗿",
        description: "moai",
        category: "Objects",
        aliases: [
            "moyai"
        ],
        tags: [
            "stone"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🪧",
        description: "placard",
        category: "Objects",
        aliases: [
            "placard"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🏧",
        description: "ATM sign",
        category: "Symbols",
        aliases: [
            "atm"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚮",
        description: "litter in bin sign",
        category: "Symbols",
        aliases: [
            "put_litter_in_its_place"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚰",
        description: "potable water",
        category: "Symbols",
        aliases: [
            "potable_water"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "♿",
        description: "wheelchair symbol",
        category: "Symbols",
        aliases: [
            "wheelchair"
        ],
        tags: [
            "accessibility"
        ],
        unicodeVersion: "4.1",
        iosVersion: "6.0"
    },
    {
        emoji: "🚹",
        description: "men’s room",
        category: "Symbols",
        aliases: [
            "mens"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚺",
        description: "women’s room",
        category: "Symbols",
        aliases: [
            "womens"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚻",
        description: "restroom",
        category: "Symbols",
        aliases: [
            "restroom"
        ],
        tags: [
            "toilet"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚼",
        description: "baby symbol",
        category: "Symbols",
        aliases: [
            "baby_symbol"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚾",
        description: "water closet",
        category: "Symbols",
        aliases: [
            "wc"
        ],
        tags: [
            "toilet",
            "restroom"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🛂",
        description: "passport control",
        category: "Symbols",
        aliases: [
            "passport_control"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🛃",
        description: "customs",
        category: "Symbols",
        aliases: [
            "customs"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🛄",
        description: "baggage claim",
        category: "Symbols",
        aliases: [
            "baggage_claim"
        ],
        tags: [
            "airport"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🛅",
        description: "left luggage",
        category: "Symbols",
        aliases: [
            "left_luggage"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "⚠️",
        description: "warning",
        category: "Symbols",
        aliases: [
            "warning"
        ],
        tags: [
            "wip"
        ],
        unicodeVersion: "4.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚸",
        description: "children crossing",
        category: "Symbols",
        aliases: [
            "children_crossing"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "⛔",
        description: "no entry",
        category: "Symbols",
        aliases: [
            "no_entry"
        ],
        tags: [
            "limit"
        ],
        unicodeVersion: "5.2",
        iosVersion: "6.0"
    },
    {
        emoji: "🚫",
        description: "prohibited",
        category: "Symbols",
        aliases: [
            "no_entry_sign"
        ],
        tags: [
            "block",
            "forbidden"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚳",
        description: "no bicycles",
        category: "Symbols",
        aliases: [
            "no_bicycles"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚭",
        description: "no smoking",
        category: "Symbols",
        aliases: [
            "no_smoking"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚯",
        description: "no littering",
        category: "Symbols",
        aliases: [
            "do_not_litter"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚱",
        description: "non-potable water",
        category: "Symbols",
        aliases: [
            "non-potable_water"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚷",
        description: "no pedestrians",
        category: "Symbols",
        aliases: [
            "no_pedestrians"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📵",
        description: "no mobile phones",
        category: "Symbols",
        aliases: [
            "no_mobile_phones"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔞",
        description: "no one under eighteen",
        category: "Symbols",
        aliases: [
            "underage"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "☢️",
        description: "radioactive",
        category: "Symbols",
        aliases: [
            "radioactive"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "9.1"
    },
    {
        emoji: "☣️",
        description: "biohazard",
        category: "Symbols",
        aliases: [
            "biohazard"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "9.1"
    },
    {
        emoji: "⬆️",
        description: "up arrow",
        category: "Symbols",
        aliases: [
            "arrow_up"
        ],
        tags: [],
        unicodeVersion: "4.0",
        iosVersion: "6.0"
    },
    {
        emoji: "↗️",
        description: "up-right arrow",
        category: "Symbols",
        aliases: [
            "arrow_upper_right"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "➡️",
        description: "right arrow",
        category: "Symbols",
        aliases: [
            "arrow_right"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "↘️",
        description: "down-right arrow",
        category: "Symbols",
        aliases: [
            "arrow_lower_right"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "⬇️",
        description: "down arrow",
        category: "Symbols",
        aliases: [
            "arrow_down"
        ],
        tags: [],
        unicodeVersion: "4.0",
        iosVersion: "6.0"
    },
    {
        emoji: "↙️",
        description: "down-left arrow",
        category: "Symbols",
        aliases: [
            "arrow_lower_left"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "⬅️",
        description: "left arrow",
        category: "Symbols",
        aliases: [
            "arrow_left"
        ],
        tags: [],
        unicodeVersion: "4.0",
        iosVersion: "6.0"
    },
    {
        emoji: "↖️",
        description: "up-left arrow",
        category: "Symbols",
        aliases: [
            "arrow_upper_left"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "↕️",
        description: "up-down arrow",
        category: "Symbols",
        aliases: [
            "arrow_up_down"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "↔️",
        description: "left-right arrow",
        category: "Symbols",
        aliases: [
            "left_right_arrow"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "↩️",
        description: "right arrow curving left",
        category: "Symbols",
        aliases: [
            "leftwards_arrow_with_hook"
        ],
        tags: [
            "return"
        ],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "↪️",
        description: "left arrow curving right",
        category: "Symbols",
        aliases: [
            "arrow_right_hook"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "⤴️",
        description: "right arrow curving up",
        category: "Symbols",
        aliases: [
            "arrow_heading_up"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "⤵️",
        description: "right arrow curving down",
        category: "Symbols",
        aliases: [
            "arrow_heading_down"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "🔃",
        description: "clockwise vertical arrows",
        category: "Symbols",
        aliases: [
            "arrows_clockwise"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔄",
        description: "counterclockwise arrows button",
        category: "Symbols",
        aliases: [
            "arrows_counterclockwise"
        ],
        tags: [
            "sync"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔙",
        description: "BACK arrow",
        category: "Symbols",
        aliases: [
            "back"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔚",
        description: "END arrow",
        category: "Symbols",
        aliases: [
            "end"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔛",
        description: "ON! arrow",
        category: "Symbols",
        aliases: [
            "on"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔜",
        description: "SOON arrow",
        category: "Symbols",
        aliases: [
            "soon"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔝",
        description: "TOP arrow",
        category: "Symbols",
        aliases: [
            "top"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🛐",
        description: "place of worship",
        category: "Symbols",
        aliases: [
            "place_of_worship"
        ],
        tags: [],
        unicodeVersion: "8.0",
        iosVersion: "9.1"
    },
    {
        emoji: "⚛️",
        description: "atom symbol",
        category: "Symbols",
        aliases: [
            "atom_symbol"
        ],
        tags: [],
        unicodeVersion: "4.1",
        iosVersion: "9.1"
    },
    {
        emoji: "🕉️",
        description: "om",
        category: "Symbols",
        aliases: [
            "om"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "✡️",
        description: "star of David",
        category: "Symbols",
        aliases: [
            "star_of_david"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "9.1"
    },
    {
        emoji: "☸️",
        description: "wheel of dharma",
        category: "Symbols",
        aliases: [
            "wheel_of_dharma"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "9.1"
    },
    {
        emoji: "☯️",
        description: "yin yang",
        category: "Symbols",
        aliases: [
            "yin_yang"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "9.1"
    },
    {
        emoji: "✝️",
        description: "latin cross",
        category: "Symbols",
        aliases: [
            "latin_cross"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "9.1"
    },
    {
        emoji: "☦️",
        description: "orthodox cross",
        category: "Symbols",
        aliases: [
            "orthodox_cross"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "9.1"
    },
    {
        emoji: "☪️",
        description: "star and crescent",
        category: "Symbols",
        aliases: [
            "star_and_crescent"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "9.1"
    },
    {
        emoji: "☮️",
        description: "peace symbol",
        category: "Symbols",
        aliases: [
            "peace_symbol"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "9.1"
    },
    {
        emoji: "🕎",
        description: "menorah",
        category: "Symbols",
        aliases: [
            "menorah"
        ],
        tags: [],
        unicodeVersion: "8.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🔯",
        description: "dotted six-pointed star",
        category: "Symbols",
        aliases: [
            "six_pointed_star"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "♈",
        description: "Aries",
        category: "Symbols",
        aliases: [
            "aries"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "♉",
        description: "Taurus",
        category: "Symbols",
        aliases: [
            "taurus"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "♊",
        description: "Gemini",
        category: "Symbols",
        aliases: [
            "gemini"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "♋",
        description: "Cancer",
        category: "Symbols",
        aliases: [
            "cancer"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "♌",
        description: "Leo",
        category: "Symbols",
        aliases: [
            "leo"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "♍",
        description: "Virgo",
        category: "Symbols",
        aliases: [
            "virgo"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "♎",
        description: "Libra",
        category: "Symbols",
        aliases: [
            "libra"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "♏",
        description: "Scorpio",
        category: "Symbols",
        aliases: [
            "scorpius"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "♐",
        description: "Sagittarius",
        category: "Symbols",
        aliases: [
            "sagittarius"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "♑",
        description: "Capricorn",
        category: "Symbols",
        aliases: [
            "capricorn"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "♒",
        description: "Aquarius",
        category: "Symbols",
        aliases: [
            "aquarius"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "♓",
        description: "Pisces",
        category: "Symbols",
        aliases: [
            "pisces"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "⛎",
        description: "Ophiuchus",
        category: "Symbols",
        aliases: [
            "ophiuchus"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔀",
        description: "shuffle tracks button",
        category: "Symbols",
        aliases: [
            "twisted_rightwards_arrows"
        ],
        tags: [
            "shuffle"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔁",
        description: "repeat button",
        category: "Symbols",
        aliases: [
            "repeat"
        ],
        tags: [
            "loop"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔂",
        description: "repeat single button",
        category: "Symbols",
        aliases: [
            "repeat_one"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "▶️",
        description: "play button",
        category: "Symbols",
        aliases: [
            "arrow_forward"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "⏩",
        description: "fast-forward button",
        category: "Symbols",
        aliases: [
            "fast_forward"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "⏭️",
        description: "next track button",
        category: "Symbols",
        aliases: [
            "next_track_button"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.1"
    },
    {
        emoji: "⏯️",
        description: "play or pause button",
        category: "Symbols",
        aliases: [
            "play_or_pause_button"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.1"
    },
    {
        emoji: "◀️",
        description: "reverse button",
        category: "Symbols",
        aliases: [
            "arrow_backward"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "⏪",
        description: "fast reverse button",
        category: "Symbols",
        aliases: [
            "rewind"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "⏮️",
        description: "last track button",
        category: "Symbols",
        aliases: [
            "previous_track_button"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🔼",
        description: "upwards button",
        category: "Symbols",
        aliases: [
            "arrow_up_small"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "⏫",
        description: "fast up button",
        category: "Symbols",
        aliases: [
            "arrow_double_up"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔽",
        description: "downwards button",
        category: "Symbols",
        aliases: [
            "arrow_down_small"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "⏬",
        description: "fast down button",
        category: "Symbols",
        aliases: [
            "arrow_double_down"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "⏸️",
        description: "pause button",
        category: "Symbols",
        aliases: [
            "pause_button"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "⏹️",
        description: "stop button",
        category: "Symbols",
        aliases: [
            "stop_button"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "⏺️",
        description: "record button",
        category: "Symbols",
        aliases: [
            "record_button"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "⏏️",
        description: "eject button",
        category: "Symbols",
        aliases: [
            "eject_button"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🎦",
        description: "cinema",
        category: "Symbols",
        aliases: [
            "cinema"
        ],
        tags: [
            "film",
            "movie"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔅",
        description: "dim button",
        category: "Symbols",
        aliases: [
            "low_brightness"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔆",
        description: "bright button",
        category: "Symbols",
        aliases: [
            "high_brightness"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📶",
        description: "antenna bars",
        category: "Symbols",
        aliases: [
            "signal_strength"
        ],
        tags: [
            "wifi"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📳",
        description: "vibration mode",
        category: "Symbols",
        aliases: [
            "vibration_mode"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📴",
        description: "mobile phone off",
        category: "Symbols",
        aliases: [
            "mobile_phone_off"
        ],
        tags: [
            "mute",
            "off"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "♀️",
        description: "female sign",
        category: "Symbols",
        aliases: [
            "female_sign"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "♂️",
        description: "male sign",
        category: "Symbols",
        aliases: [
            "male_sign"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "⚧️",
        description: "transgender symbol",
        category: "Symbols",
        aliases: [
            "transgender_symbol"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "✖️",
        description: "multiply",
        category: "Symbols",
        aliases: [
            "heavy_multiplication_x"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "➕",
        description: "plus",
        category: "Symbols",
        aliases: [
            "heavy_plus_sign"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "➖",
        description: "minus",
        category: "Symbols",
        aliases: [
            "heavy_minus_sign"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "➗",
        description: "divide",
        category: "Symbols",
        aliases: [
            "heavy_division_sign"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "♾️",
        description: "infinity",
        category: "Symbols",
        aliases: [
            "infinity"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "‼️",
        description: "double exclamation mark",
        category: "Symbols",
        aliases: [
            "bangbang"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "⁉️",
        description: "exclamation question mark",
        category: "Symbols",
        aliases: [
            "interrobang"
        ],
        tags: [],
        unicodeVersion: "3.0",
        iosVersion: "6.0"
    },
    {
        emoji: "❓",
        description: "question mark",
        category: "Symbols",
        aliases: [
            "question"
        ],
        tags: [
            "confused"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "❔",
        description: "white question mark",
        category: "Symbols",
        aliases: [
            "grey_question"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "❕",
        description: "white exclamation mark",
        category: "Symbols",
        aliases: [
            "grey_exclamation"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "❗",
        description: "exclamation mark",
        category: "Symbols",
        aliases: [
            "exclamation",
            "heavy_exclamation_mark"
        ],
        tags: [
            "bang"
        ],
        unicodeVersion: "5.2",
        iosVersion: "6.0"
    },
    {
        emoji: "〰️",
        description: "wavy dash",
        category: "Symbols",
        aliases: [
            "wavy_dash"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "💱",
        description: "currency exchange",
        category: "Symbols",
        aliases: [
            "currency_exchange"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💲",
        description: "heavy dollar sign",
        category: "Symbols",
        aliases: [
            "heavy_dollar_sign"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "⚕️",
        description: "medical symbol",
        category: "Symbols",
        aliases: [
            "medical_symbol"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "♻️",
        description: "recycling symbol",
        category: "Symbols",
        aliases: [
            "recycle"
        ],
        tags: [
            "environment",
            "green"
        ],
        unicodeVersion: "3.2",
        iosVersion: "6.0"
    },
    {
        emoji: "⚜️",
        description: "fleur-de-lis",
        category: "Symbols",
        aliases: [
            "fleur_de_lis"
        ],
        tags: [],
        unicodeVersion: "4.1",
        iosVersion: "9.1"
    },
    {
        emoji: "🔱",
        description: "trident emblem",
        category: "Symbols",
        aliases: [
            "trident"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "📛",
        description: "name badge",
        category: "Symbols",
        aliases: [
            "name_badge"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔰",
        description: "Japanese symbol for beginner",
        category: "Symbols",
        aliases: [
            "beginner"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "⭕",
        description: "hollow red circle",
        category: "Symbols",
        aliases: [
            "o"
        ],
        tags: [],
        unicodeVersion: "5.2",
        iosVersion: "6.0"
    },
    {
        emoji: "✅",
        description: "check mark button",
        category: "Symbols",
        aliases: [
            "white_check_mark"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "☑️",
        description: "check box with check",
        category: "Symbols",
        aliases: [
            "ballot_box_with_check"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "✔️",
        description: "check mark",
        category: "Symbols",
        aliases: [
            "heavy_check_mark"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "❌",
        description: "cross mark",
        category: "Symbols",
        aliases: [
            "x"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "❎",
        description: "cross mark button",
        category: "Symbols",
        aliases: [
            "negative_squared_cross_mark"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "➰",
        description: "curly loop",
        category: "Symbols",
        aliases: [
            "curly_loop"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "➿",
        description: "double curly loop",
        category: "Symbols",
        aliases: [
            "loop"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "〽️",
        description: "part alternation mark",
        category: "Symbols",
        aliases: [
            "part_alternation_mark"
        ],
        tags: [],
        unicodeVersion: "3.2",
        iosVersion: "6.0"
    },
    {
        emoji: "✳️",
        description: "eight-spoked asterisk",
        category: "Symbols",
        aliases: [
            "eight_spoked_asterisk"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "✴️",
        description: "eight-pointed star",
        category: "Symbols",
        aliases: [
            "eight_pointed_black_star"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "❇️",
        description: "sparkle",
        category: "Symbols",
        aliases: [
            "sparkle"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "©️",
        description: "copyright",
        category: "Symbols",
        aliases: [
            "copyright"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "®️",
        description: "registered",
        category: "Symbols",
        aliases: [
            "registered"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "™️",
        description: "trade mark",
        category: "Symbols",
        aliases: [
            "tm"
        ],
        tags: [
            "trademark"
        ],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "#️⃣",
        description: "keycap: #",
        category: "Symbols",
        aliases: [
            "hash"
        ],
        tags: [
            "number"
        ],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "*️⃣",
        description: "keycap: *",
        category: "Symbols",
        aliases: [
            "asterisk"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "9.1"
    },
    {
        emoji: "0️⃣",
        description: "keycap: 0",
        category: "Symbols",
        aliases: [
            "zero"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "1️⃣",
        description: "keycap: 1",
        category: "Symbols",
        aliases: [
            "one"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "2️⃣",
        description: "keycap: 2",
        category: "Symbols",
        aliases: [
            "two"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "3️⃣",
        description: "keycap: 3",
        category: "Symbols",
        aliases: [
            "three"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "4️⃣",
        description: "keycap: 4",
        category: "Symbols",
        aliases: [
            "four"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "5️⃣",
        description: "keycap: 5",
        category: "Symbols",
        aliases: [
            "five"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "6️⃣",
        description: "keycap: 6",
        category: "Symbols",
        aliases: [
            "six"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "7️⃣",
        description: "keycap: 7",
        category: "Symbols",
        aliases: [
            "seven"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "8️⃣",
        description: "keycap: 8",
        category: "Symbols",
        aliases: [
            "eight"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "9️⃣",
        description: "keycap: 9",
        category: "Symbols",
        aliases: [
            "nine"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "🔟",
        description: "keycap: 10",
        category: "Symbols",
        aliases: [
            "keycap_ten"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔠",
        description: "input latin uppercase",
        category: "Symbols",
        aliases: [
            "capital_abcd"
        ],
        tags: [
            "letters"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔡",
        description: "input latin lowercase",
        category: "Symbols",
        aliases: [
            "abcd"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔢",
        description: "input numbers",
        category: "Symbols",
        aliases: [
            "1234"
        ],
        tags: [
            "numbers"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔣",
        description: "input symbols",
        category: "Symbols",
        aliases: [
            "symbols"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔤",
        description: "input latin letters",
        category: "Symbols",
        aliases: [
            "abc"
        ],
        tags: [
            "alphabet"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🅰️",
        description: "A button (blood type)",
        category: "Symbols",
        aliases: [
            "a"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🆎",
        description: "AB button (blood type)",
        category: "Symbols",
        aliases: [
            "ab"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🅱️",
        description: "B button (blood type)",
        category: "Symbols",
        aliases: [
            "b"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🆑",
        description: "CL button",
        category: "Symbols",
        aliases: [
            "cl"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🆒",
        description: "COOL button",
        category: "Symbols",
        aliases: [
            "cool"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🆓",
        description: "FREE button",
        category: "Symbols",
        aliases: [
            "free"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "ℹ️",
        description: "information",
        category: "Symbols",
        aliases: [
            "information_source"
        ],
        tags: [],
        unicodeVersion: "3.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🆔",
        description: "ID button",
        category: "Symbols",
        aliases: [
            "id"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "Ⓜ️",
        description: "circled M",
        category: "Symbols",
        aliases: [
            "m"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "🆕",
        description: "NEW button",
        category: "Symbols",
        aliases: [
            "new"
        ],
        tags: [
            "fresh"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🆖",
        description: "NG button",
        category: "Symbols",
        aliases: [
            "ng"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🅾️",
        description: "O button (blood type)",
        category: "Symbols",
        aliases: [
            "o2"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🆗",
        description: "OK button",
        category: "Symbols",
        aliases: [
            "ok"
        ],
        tags: [
            "yes"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🅿️",
        description: "P button",
        category: "Symbols",
        aliases: [
            "parking"
        ],
        tags: [],
        unicodeVersion: "5.2",
        iosVersion: "6.0"
    },
    {
        emoji: "🆘",
        description: "SOS button",
        category: "Symbols",
        aliases: [
            "sos"
        ],
        tags: [
            "help",
            "emergency"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🆙",
        description: "UP! button",
        category: "Symbols",
        aliases: [
            "up"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🆚",
        description: "VS button",
        category: "Symbols",
        aliases: [
            "vs"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🈁",
        description: "Japanese “here” button",
        category: "Symbols",
        aliases: [
            "koko"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🈂️",
        description: "Japanese “service charge” button",
        category: "Symbols",
        aliases: [
            "sa"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🈷️",
        description: "Japanese “monthly amount” button",
        category: "Symbols",
        aliases: [
            "u6708"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🈶",
        description: "Japanese “not free of charge” button",
        category: "Symbols",
        aliases: [
            "u6709"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🈯",
        description: "Japanese “reserved” button",
        category: "Symbols",
        aliases: [
            "u6307"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "🉐",
        description: "Japanese “bargain” button",
        category: "Symbols",
        aliases: [
            "ideograph_advantage"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🈹",
        description: "Japanese “discount” button",
        category: "Symbols",
        aliases: [
            "u5272"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🈚",
        description: "Japanese “free of charge” button",
        category: "Symbols",
        aliases: [
            "u7121"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "🈲",
        description: "Japanese “prohibited” button",
        category: "Symbols",
        aliases: [
            "u7981"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🉑",
        description: "Japanese “acceptable” button",
        category: "Symbols",
        aliases: [
            "accept"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🈸",
        description: "Japanese “application” button",
        category: "Symbols",
        aliases: [
            "u7533"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🈴",
        description: "Japanese “passing grade” button",
        category: "Symbols",
        aliases: [
            "u5408"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🈳",
        description: "Japanese “vacancy” button",
        category: "Symbols",
        aliases: [
            "u7a7a"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "㊗️",
        description: "Japanese “congratulations” button",
        category: "Symbols",
        aliases: [
            "congratulations"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "㊙️",
        description: "Japanese “secret” button",
        category: "Symbols",
        aliases: [
            "secret"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "🈺",
        description: "Japanese “open for business” button",
        category: "Symbols",
        aliases: [
            "u55b6"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🈵",
        description: "Japanese “no vacancy” button",
        category: "Symbols",
        aliases: [
            "u6e80"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔴",
        description: "red circle",
        category: "Symbols",
        aliases: [
            "red_circle"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🟠",
        description: "orange circle",
        category: "Symbols",
        aliases: [
            "orange_circle"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🟡",
        description: "yellow circle",
        category: "Symbols",
        aliases: [
            "yellow_circle"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🟢",
        description: "green circle",
        category: "Symbols",
        aliases: [
            "green_circle"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🔵",
        description: "blue circle",
        category: "Symbols",
        aliases: [
            "large_blue_circle"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🟣",
        description: "purple circle",
        category: "Symbols",
        aliases: [
            "purple_circle"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🟤",
        description: "brown circle",
        category: "Symbols",
        aliases: [
            "brown_circle"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "⚫",
        description: "black circle",
        category: "Symbols",
        aliases: [
            "black_circle"
        ],
        tags: [],
        unicodeVersion: "4.1",
        iosVersion: "6.0"
    },
    {
        emoji: "⚪",
        description: "white circle",
        category: "Symbols",
        aliases: [
            "white_circle"
        ],
        tags: [],
        unicodeVersion: "4.1",
        iosVersion: "6.0"
    },
    {
        emoji: "🟥",
        description: "red square",
        category: "Symbols",
        aliases: [
            "red_square"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🟧",
        description: "orange square",
        category: "Symbols",
        aliases: [
            "orange_square"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🟨",
        description: "yellow square",
        category: "Symbols",
        aliases: [
            "yellow_square"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🟩",
        description: "green square",
        category: "Symbols",
        aliases: [
            "green_square"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🟦",
        description: "blue square",
        category: "Symbols",
        aliases: [
            "blue_square"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🟪",
        description: "purple square",
        category: "Symbols",
        aliases: [
            "purple_square"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "🟫",
        description: "brown square",
        category: "Symbols",
        aliases: [
            "brown_square"
        ],
        tags: [],
        unicodeVersion: "12.0",
        iosVersion: "13.0"
    },
    {
        emoji: "⬛",
        description: "black large square",
        category: "Symbols",
        aliases: [
            "black_large_square"
        ],
        tags: [],
        unicodeVersion: "5.1",
        iosVersion: "6.0"
    },
    {
        emoji: "⬜",
        description: "white large square",
        category: "Symbols",
        aliases: [
            "white_large_square"
        ],
        tags: [],
        unicodeVersion: "5.1",
        iosVersion: "6.0"
    },
    {
        emoji: "◼️",
        description: "black medium square",
        category: "Symbols",
        aliases: [
            "black_medium_square"
        ],
        tags: [],
        unicodeVersion: "3.2",
        iosVersion: "6.0"
    },
    {
        emoji: "◻️",
        description: "white medium square",
        category: "Symbols",
        aliases: [
            "white_medium_square"
        ],
        tags: [],
        unicodeVersion: "3.2",
        iosVersion: "6.0"
    },
    {
        emoji: "◾",
        description: "black medium-small square",
        category: "Symbols",
        aliases: [
            "black_medium_small_square"
        ],
        tags: [],
        unicodeVersion: "3.2",
        iosVersion: "6.0"
    },
    {
        emoji: "◽",
        description: "white medium-small square",
        category: "Symbols",
        aliases: [
            "white_medium_small_square"
        ],
        tags: [],
        unicodeVersion: "3.2",
        iosVersion: "6.0"
    },
    {
        emoji: "▪️",
        description: "black small square",
        category: "Symbols",
        aliases: [
            "black_small_square"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "▫️",
        description: "white small square",
        category: "Symbols",
        aliases: [
            "white_small_square"
        ],
        tags: [],
        unicodeVersion: "",
        iosVersion: "6.0"
    },
    {
        emoji: "🔶",
        description: "large orange diamond",
        category: "Symbols",
        aliases: [
            "large_orange_diamond"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔷",
        description: "large blue diamond",
        category: "Symbols",
        aliases: [
            "large_blue_diamond"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔸",
        description: "small orange diamond",
        category: "Symbols",
        aliases: [
            "small_orange_diamond"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔹",
        description: "small blue diamond",
        category: "Symbols",
        aliases: [
            "small_blue_diamond"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔺",
        description: "red triangle pointed up",
        category: "Symbols",
        aliases: [
            "small_red_triangle"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔻",
        description: "red triangle pointed down",
        category: "Symbols",
        aliases: [
            "small_red_triangle_down"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "💠",
        description: "diamond with a dot",
        category: "Symbols",
        aliases: [
            "diamond_shape_with_a_dot_inside"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔘",
        description: "radio button",
        category: "Symbols",
        aliases: [
            "radio_button"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔳",
        description: "white square button",
        category: "Symbols",
        aliases: [
            "white_square_button"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🔲",
        description: "black square button",
        category: "Symbols",
        aliases: [
            "black_square_button"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🏁",
        description: "chequered flag",
        category: "Flags",
        aliases: [
            "checkered_flag"
        ],
        tags: [
            "milestone",
            "finish"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🚩",
        description: "triangular flag",
        category: "Flags",
        aliases: [
            "triangular_flag_on_post"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🎌",
        description: "crossed flags",
        category: "Flags",
        aliases: [
            "crossed_flags"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🏴",
        description: "black flag",
        category: "Flags",
        aliases: [
            "black_flag"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🏳️",
        description: "white flag",
        category: "Flags",
        aliases: [
            "white_flag"
        ],
        tags: [],
        unicodeVersion: "7.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🏳️‍🌈",
        description: "rainbow flag",
        category: "Flags",
        aliases: [
            "rainbow_flag"
        ],
        tags: [
            "pride"
        ],
        unicodeVersion: "6.0",
        iosVersion: "10.0"
    },
    {
        emoji: "🏳️‍⚧️",
        description: "transgender flag",
        category: "Flags",
        aliases: [
            "transgender_flag"
        ],
        tags: [],
        unicodeVersion: "13.0",
        iosVersion: "14.0"
    },
    {
        emoji: "🏴‍☠️",
        description: "pirate flag",
        category: "Flags",
        aliases: [
            "pirate_flag"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🇦🇨",
        description: "flag: Ascension Island",
        category: "Flags",
        aliases: [
            "ascension_island"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🇦🇩",
        description: "flag: Andorra",
        category: "Flags",
        aliases: [
            "andorra"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇦🇪",
        description: "flag: United Arab Emirates",
        category: "Flags",
        aliases: [
            "united_arab_emirates"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇦🇫",
        description: "flag: Afghanistan",
        category: "Flags",
        aliases: [
            "afghanistan"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇦🇬",
        description: "flag: Antigua & Barbuda",
        category: "Flags",
        aliases: [
            "antigua_barbuda"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇦🇮",
        description: "flag: Anguilla",
        category: "Flags",
        aliases: [
            "anguilla"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇦🇱",
        description: "flag: Albania",
        category: "Flags",
        aliases: [
            "albania"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇦🇲",
        description: "flag: Armenia",
        category: "Flags",
        aliases: [
            "armenia"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇦🇴",
        description: "flag: Angola",
        category: "Flags",
        aliases: [
            "angola"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇦🇶",
        description: "flag: Antarctica",
        category: "Flags",
        aliases: [
            "antarctica"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.0"
    },
    {
        emoji: "🇦🇷",
        description: "flag: Argentina",
        category: "Flags",
        aliases: [
            "argentina"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇦🇸",
        description: "flag: American Samoa",
        category: "Flags",
        aliases: [
            "american_samoa"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇦🇹",
        description: "flag: Austria",
        category: "Flags",
        aliases: [
            "austria"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇦🇺",
        description: "flag: Australia",
        category: "Flags",
        aliases: [
            "australia"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇦🇼",
        description: "flag: Aruba",
        category: "Flags",
        aliases: [
            "aruba"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇦🇽",
        description: "flag: Åland Islands",
        category: "Flags",
        aliases: [
            "aland_islands"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.0"
    },
    {
        emoji: "🇦🇿",
        description: "flag: Azerbaijan",
        category: "Flags",
        aliases: [
            "azerbaijan"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇧🇦",
        description: "flag: Bosnia & Herzegovina",
        category: "Flags",
        aliases: [
            "bosnia_herzegovina"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇧🇧",
        description: "flag: Barbados",
        category: "Flags",
        aliases: [
            "barbados"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇧🇩",
        description: "flag: Bangladesh",
        category: "Flags",
        aliases: [
            "bangladesh"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇧🇪",
        description: "flag: Belgium",
        category: "Flags",
        aliases: [
            "belgium"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇧🇫",
        description: "flag: Burkina Faso",
        category: "Flags",
        aliases: [
            "burkina_faso"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇧🇬",
        description: "flag: Bulgaria",
        category: "Flags",
        aliases: [
            "bulgaria"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇧🇭",
        description: "flag: Bahrain",
        category: "Flags",
        aliases: [
            "bahrain"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇧🇮",
        description: "flag: Burundi",
        category: "Flags",
        aliases: [
            "burundi"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇧🇯",
        description: "flag: Benin",
        category: "Flags",
        aliases: [
            "benin"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇧🇱",
        description: "flag: St. Barthélemy",
        category: "Flags",
        aliases: [
            "st_barthelemy"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.0"
    },
    {
        emoji: "🇧🇲",
        description: "flag: Bermuda",
        category: "Flags",
        aliases: [
            "bermuda"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇧🇳",
        description: "flag: Brunei",
        category: "Flags",
        aliases: [
            "brunei"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇧🇴",
        description: "flag: Bolivia",
        category: "Flags",
        aliases: [
            "bolivia"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇧🇶",
        description: "flag: Caribbean Netherlands",
        category: "Flags",
        aliases: [
            "caribbean_netherlands"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.0"
    },
    {
        emoji: "🇧🇷",
        description: "flag: Brazil",
        category: "Flags",
        aliases: [
            "brazil"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇧🇸",
        description: "flag: Bahamas",
        category: "Flags",
        aliases: [
            "bahamas"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇧🇹",
        description: "flag: Bhutan",
        category: "Flags",
        aliases: [
            "bhutan"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇧🇻",
        description: "flag: Bouvet Island",
        category: "Flags",
        aliases: [
            "bouvet_island"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🇧🇼",
        description: "flag: Botswana",
        category: "Flags",
        aliases: [
            "botswana"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇧🇾",
        description: "flag: Belarus",
        category: "Flags",
        aliases: [
            "belarus"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇧🇿",
        description: "flag: Belize",
        category: "Flags",
        aliases: [
            "belize"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇨🇦",
        description: "flag: Canada",
        category: "Flags",
        aliases: [
            "canada"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇨🇨",
        description: "flag: Cocos (Keeling) Islands",
        category: "Flags",
        aliases: [
            "cocos_islands"
        ],
        tags: [
            "keeling"
        ],
        unicodeVersion: "6.0",
        iosVersion: "9.0"
    },
    {
        emoji: "🇨🇩",
        description: "flag: Congo - Kinshasa",
        category: "Flags",
        aliases: [
            "congo_kinshasa"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇨🇫",
        description: "flag: Central African Republic",
        category: "Flags",
        aliases: [
            "central_african_republic"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇨🇬",
        description: "flag: Congo - Brazzaville",
        category: "Flags",
        aliases: [
            "congo_brazzaville"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇨🇭",
        description: "flag: Switzerland",
        category: "Flags",
        aliases: [
            "switzerland"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇨🇮",
        description: "flag: Côte d’Ivoire",
        category: "Flags",
        aliases: [
            "cote_divoire"
        ],
        tags: [
            "ivory"
        ],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇨🇰",
        description: "flag: Cook Islands",
        category: "Flags",
        aliases: [
            "cook_islands"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇨🇱",
        description: "flag: Chile",
        category: "Flags",
        aliases: [
            "chile"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇨🇲",
        description: "flag: Cameroon",
        category: "Flags",
        aliases: [
            "cameroon"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇨🇳",
        description: "flag: China",
        category: "Flags",
        aliases: [
            "cn"
        ],
        tags: [
            "china"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🇨🇴",
        description: "flag: Colombia",
        category: "Flags",
        aliases: [
            "colombia"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇨🇵",
        description: "flag: Clipperton Island",
        category: "Flags",
        aliases: [
            "clipperton_island"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🇨🇷",
        description: "flag: Costa Rica",
        category: "Flags",
        aliases: [
            "costa_rica"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇨🇺",
        description: "flag: Cuba",
        category: "Flags",
        aliases: [
            "cuba"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇨🇻",
        description: "flag: Cape Verde",
        category: "Flags",
        aliases: [
            "cape_verde"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇨🇼",
        description: "flag: Curaçao",
        category: "Flags",
        aliases: [
            "curacao"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇨🇽",
        description: "flag: Christmas Island",
        category: "Flags",
        aliases: [
            "christmas_island"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.0"
    },
    {
        emoji: "🇨🇾",
        description: "flag: Cyprus",
        category: "Flags",
        aliases: [
            "cyprus"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇨🇿",
        description: "flag: Czechia",
        category: "Flags",
        aliases: [
            "czech_republic"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇩🇪",
        description: "flag: Germany",
        category: "Flags",
        aliases: [
            "de"
        ],
        tags: [
            "flag",
            "germany"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🇩🇬",
        description: "flag: Diego Garcia",
        category: "Flags",
        aliases: [
            "diego_garcia"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🇩🇯",
        description: "flag: Djibouti",
        category: "Flags",
        aliases: [
            "djibouti"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇩🇰",
        description: "flag: Denmark",
        category: "Flags",
        aliases: [
            "denmark"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇩🇲",
        description: "flag: Dominica",
        category: "Flags",
        aliases: [
            "dominica"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇩🇴",
        description: "flag: Dominican Republic",
        category: "Flags",
        aliases: [
            "dominican_republic"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇩🇿",
        description: "flag: Algeria",
        category: "Flags",
        aliases: [
            "algeria"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇪🇦",
        description: "flag: Ceuta & Melilla",
        category: "Flags",
        aliases: [
            "ceuta_melilla"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🇪🇨",
        description: "flag: Ecuador",
        category: "Flags",
        aliases: [
            "ecuador"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇪🇪",
        description: "flag: Estonia",
        category: "Flags",
        aliases: [
            "estonia"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇪🇬",
        description: "flag: Egypt",
        category: "Flags",
        aliases: [
            "egypt"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇪🇭",
        description: "flag: Western Sahara",
        category: "Flags",
        aliases: [
            "western_sahara"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.0"
    },
    {
        emoji: "🇪🇷",
        description: "flag: Eritrea",
        category: "Flags",
        aliases: [
            "eritrea"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇪🇸",
        description: "flag: Spain",
        category: "Flags",
        aliases: [
            "es"
        ],
        tags: [
            "spain"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🇪🇹",
        description: "flag: Ethiopia",
        category: "Flags",
        aliases: [
            "ethiopia"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇪🇺",
        description: "flag: European Union",
        category: "Flags",
        aliases: [
            "eu",
            "european_union"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.0"
    },
    {
        emoji: "🇫🇮",
        description: "flag: Finland",
        category: "Flags",
        aliases: [
            "finland"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇫🇯",
        description: "flag: Fiji",
        category: "Flags",
        aliases: [
            "fiji"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇫🇰",
        description: "flag: Falkland Islands",
        category: "Flags",
        aliases: [
            "falkland_islands"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.0"
    },
    {
        emoji: "🇫🇲",
        description: "flag: Micronesia",
        category: "Flags",
        aliases: [
            "micronesia"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.0"
    },
    {
        emoji: "🇫🇴",
        description: "flag: Faroe Islands",
        category: "Flags",
        aliases: [
            "faroe_islands"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇫🇷",
        description: "flag: France",
        category: "Flags",
        aliases: [
            "fr"
        ],
        tags: [
            "france",
            "french"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🇬🇦",
        description: "flag: Gabon",
        category: "Flags",
        aliases: [
            "gabon"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇬🇧",
        description: "flag: United Kingdom",
        category: "Flags",
        aliases: [
            "gb",
            "uk"
        ],
        tags: [
            "flag",
            "british"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🇬🇩",
        description: "flag: Grenada",
        category: "Flags",
        aliases: [
            "grenada"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇬🇪",
        description: "flag: Georgia",
        category: "Flags",
        aliases: [
            "georgia"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇬🇫",
        description: "flag: French Guiana",
        category: "Flags",
        aliases: [
            "french_guiana"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇬🇬",
        description: "flag: Guernsey",
        category: "Flags",
        aliases: [
            "guernsey"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.0"
    },
    {
        emoji: "🇬🇭",
        description: "flag: Ghana",
        category: "Flags",
        aliases: [
            "ghana"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇬🇮",
        description: "flag: Gibraltar",
        category: "Flags",
        aliases: [
            "gibraltar"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇬🇱",
        description: "flag: Greenland",
        category: "Flags",
        aliases: [
            "greenland"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.0"
    },
    {
        emoji: "🇬🇲",
        description: "flag: Gambia",
        category: "Flags",
        aliases: [
            "gambia"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇬🇳",
        description: "flag: Guinea",
        category: "Flags",
        aliases: [
            "guinea"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇬🇵",
        description: "flag: Guadeloupe",
        category: "Flags",
        aliases: [
            "guadeloupe"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.0"
    },
    {
        emoji: "🇬🇶",
        description: "flag: Equatorial Guinea",
        category: "Flags",
        aliases: [
            "equatorial_guinea"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇬🇷",
        description: "flag: Greece",
        category: "Flags",
        aliases: [
            "greece"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇬🇸",
        description: "flag: South Georgia & South Sandwich Islands",
        category: "Flags",
        aliases: [
            "south_georgia_south_sandwich_islands"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.0"
    },
    {
        emoji: "🇬🇹",
        description: "flag: Guatemala",
        category: "Flags",
        aliases: [
            "guatemala"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇬🇺",
        description: "flag: Guam",
        category: "Flags",
        aliases: [
            "guam"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇬🇼",
        description: "flag: Guinea-Bissau",
        category: "Flags",
        aliases: [
            "guinea_bissau"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇬🇾",
        description: "flag: Guyana",
        category: "Flags",
        aliases: [
            "guyana"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇭🇰",
        description: "flag: Hong Kong SAR China",
        category: "Flags",
        aliases: [
            "hong_kong"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇭🇲",
        description: "flag: Heard & McDonald Islands",
        category: "Flags",
        aliases: [
            "heard_mcdonald_islands"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🇭🇳",
        description: "flag: Honduras",
        category: "Flags",
        aliases: [
            "honduras"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇭🇷",
        description: "flag: Croatia",
        category: "Flags",
        aliases: [
            "croatia"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇭🇹",
        description: "flag: Haiti",
        category: "Flags",
        aliases: [
            "haiti"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇭🇺",
        description: "flag: Hungary",
        category: "Flags",
        aliases: [
            "hungary"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇮🇨",
        description: "flag: Canary Islands",
        category: "Flags",
        aliases: [
            "canary_islands"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.0"
    },
    {
        emoji: "🇮🇩",
        description: "flag: Indonesia",
        category: "Flags",
        aliases: [
            "indonesia"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇮🇪",
        description: "flag: Ireland",
        category: "Flags",
        aliases: [
            "ireland"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇮🇱",
        description: "flag: Israel",
        category: "Flags",
        aliases: [
            "israel"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇮🇲",
        description: "flag: Isle of Man",
        category: "Flags",
        aliases: [
            "isle_of_man"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.0"
    },
    {
        emoji: "🇮🇳",
        description: "flag: India",
        category: "Flags",
        aliases: [
            "india"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇮🇴",
        description: "flag: British Indian Ocean Territory",
        category: "Flags",
        aliases: [
            "british_indian_ocean_territory"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.0"
    },
    {
        emoji: "🇮🇶",
        description: "flag: Iraq",
        category: "Flags",
        aliases: [
            "iraq"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇮🇷",
        description: "flag: Iran",
        category: "Flags",
        aliases: [
            "iran"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇮🇸",
        description: "flag: Iceland",
        category: "Flags",
        aliases: [
            "iceland"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇮🇹",
        description: "flag: Italy",
        category: "Flags",
        aliases: [
            "it"
        ],
        tags: [
            "italy"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🇯🇪",
        description: "flag: Jersey",
        category: "Flags",
        aliases: [
            "jersey"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.0"
    },
    {
        emoji: "🇯🇲",
        description: "flag: Jamaica",
        category: "Flags",
        aliases: [
            "jamaica"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇯🇴",
        description: "flag: Jordan",
        category: "Flags",
        aliases: [
            "jordan"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇯🇵",
        description: "flag: Japan",
        category: "Flags",
        aliases: [
            "jp"
        ],
        tags: [
            "japan"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🇰🇪",
        description: "flag: Kenya",
        category: "Flags",
        aliases: [
            "kenya"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇰🇬",
        description: "flag: Kyrgyzstan",
        category: "Flags",
        aliases: [
            "kyrgyzstan"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇰🇭",
        description: "flag: Cambodia",
        category: "Flags",
        aliases: [
            "cambodia"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇰🇮",
        description: "flag: Kiribati",
        category: "Flags",
        aliases: [
            "kiribati"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇰🇲",
        description: "flag: Comoros",
        category: "Flags",
        aliases: [
            "comoros"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇰🇳",
        description: "flag: St. Kitts & Nevis",
        category: "Flags",
        aliases: [
            "st_kitts_nevis"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇰🇵",
        description: "flag: North Korea",
        category: "Flags",
        aliases: [
            "north_korea"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇰🇷",
        description: "flag: South Korea",
        category: "Flags",
        aliases: [
            "kr"
        ],
        tags: [
            "korea"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🇰🇼",
        description: "flag: Kuwait",
        category: "Flags",
        aliases: [
            "kuwait"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇰🇾",
        description: "flag: Cayman Islands",
        category: "Flags",
        aliases: [
            "cayman_islands"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇰🇿",
        description: "flag: Kazakhstan",
        category: "Flags",
        aliases: [
            "kazakhstan"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇱🇦",
        description: "flag: Laos",
        category: "Flags",
        aliases: [
            "laos"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇱🇧",
        description: "flag: Lebanon",
        category: "Flags",
        aliases: [
            "lebanon"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇱🇨",
        description: "flag: St. Lucia",
        category: "Flags",
        aliases: [
            "st_lucia"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇱🇮",
        description: "flag: Liechtenstein",
        category: "Flags",
        aliases: [
            "liechtenstein"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇱🇰",
        description: "flag: Sri Lanka",
        category: "Flags",
        aliases: [
            "sri_lanka"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇱🇷",
        description: "flag: Liberia",
        category: "Flags",
        aliases: [
            "liberia"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇱🇸",
        description: "flag: Lesotho",
        category: "Flags",
        aliases: [
            "lesotho"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇱🇹",
        description: "flag: Lithuania",
        category: "Flags",
        aliases: [
            "lithuania"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇱🇺",
        description: "flag: Luxembourg",
        category: "Flags",
        aliases: [
            "luxembourg"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇱🇻",
        description: "flag: Latvia",
        category: "Flags",
        aliases: [
            "latvia"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇱🇾",
        description: "flag: Libya",
        category: "Flags",
        aliases: [
            "libya"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇲🇦",
        description: "flag: Morocco",
        category: "Flags",
        aliases: [
            "morocco"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇲🇨",
        description: "flag: Monaco",
        category: "Flags",
        aliases: [
            "monaco"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.0"
    },
    {
        emoji: "🇲🇩",
        description: "flag: Moldova",
        category: "Flags",
        aliases: [
            "moldova"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇲🇪",
        description: "flag: Montenegro",
        category: "Flags",
        aliases: [
            "montenegro"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇲🇫",
        description: "flag: St. Martin",
        category: "Flags",
        aliases: [
            "st_martin"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🇲🇬",
        description: "flag: Madagascar",
        category: "Flags",
        aliases: [
            "madagascar"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇲🇭",
        description: "flag: Marshall Islands",
        category: "Flags",
        aliases: [
            "marshall_islands"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.0"
    },
    {
        emoji: "🇲🇰",
        description: "flag: North Macedonia",
        category: "Flags",
        aliases: [
            "macedonia"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇲🇱",
        description: "flag: Mali",
        category: "Flags",
        aliases: [
            "mali"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇲🇲",
        description: "flag: Myanmar (Burma)",
        category: "Flags",
        aliases: [
            "myanmar"
        ],
        tags: [
            "burma"
        ],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇲🇳",
        description: "flag: Mongolia",
        category: "Flags",
        aliases: [
            "mongolia"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇲🇴",
        description: "flag: Macao SAR China",
        category: "Flags",
        aliases: [
            "macau"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇲🇵",
        description: "flag: Northern Mariana Islands",
        category: "Flags",
        aliases: [
            "northern_mariana_islands"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇲🇶",
        description: "flag: Martinique",
        category: "Flags",
        aliases: [
            "martinique"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.0"
    },
    {
        emoji: "🇲🇷",
        description: "flag: Mauritania",
        category: "Flags",
        aliases: [
            "mauritania"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇲🇸",
        description: "flag: Montserrat",
        category: "Flags",
        aliases: [
            "montserrat"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇲🇹",
        description: "flag: Malta",
        category: "Flags",
        aliases: [
            "malta"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇲🇺",
        description: "flag: Mauritius",
        category: "Flags",
        aliases: [
            "mauritius"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.0"
    },
    {
        emoji: "🇲🇻",
        description: "flag: Maldives",
        category: "Flags",
        aliases: [
            "maldives"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇲🇼",
        description: "flag: Malawi",
        category: "Flags",
        aliases: [
            "malawi"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇲🇽",
        description: "flag: Mexico",
        category: "Flags",
        aliases: [
            "mexico"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇲🇾",
        description: "flag: Malaysia",
        category: "Flags",
        aliases: [
            "malaysia"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇲🇿",
        description: "flag: Mozambique",
        category: "Flags",
        aliases: [
            "mozambique"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇳🇦",
        description: "flag: Namibia",
        category: "Flags",
        aliases: [
            "namibia"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇳🇨",
        description: "flag: New Caledonia",
        category: "Flags",
        aliases: [
            "new_caledonia"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇳🇪",
        description: "flag: Niger",
        category: "Flags",
        aliases: [
            "niger"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇳🇫",
        description: "flag: Norfolk Island",
        category: "Flags",
        aliases: [
            "norfolk_island"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.0"
    },
    {
        emoji: "🇳🇬",
        description: "flag: Nigeria",
        category: "Flags",
        aliases: [
            "nigeria"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇳🇮",
        description: "flag: Nicaragua",
        category: "Flags",
        aliases: [
            "nicaragua"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇳🇱",
        description: "flag: Netherlands",
        category: "Flags",
        aliases: [
            "netherlands"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇳🇴",
        description: "flag: Norway",
        category: "Flags",
        aliases: [
            "norway"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇳🇵",
        description: "flag: Nepal",
        category: "Flags",
        aliases: [
            "nepal"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇳🇷",
        description: "flag: Nauru",
        category: "Flags",
        aliases: [
            "nauru"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.0"
    },
    {
        emoji: "🇳🇺",
        description: "flag: Niue",
        category: "Flags",
        aliases: [
            "niue"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇳🇿",
        description: "flag: New Zealand",
        category: "Flags",
        aliases: [
            "new_zealand"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇴🇲",
        description: "flag: Oman",
        category: "Flags",
        aliases: [
            "oman"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇵🇦",
        description: "flag: Panama",
        category: "Flags",
        aliases: [
            "panama"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇵🇪",
        description: "flag: Peru",
        category: "Flags",
        aliases: [
            "peru"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇵🇫",
        description: "flag: French Polynesia",
        category: "Flags",
        aliases: [
            "french_polynesia"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.0"
    },
    {
        emoji: "🇵🇬",
        description: "flag: Papua New Guinea",
        category: "Flags",
        aliases: [
            "papua_new_guinea"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇵🇭",
        description: "flag: Philippines",
        category: "Flags",
        aliases: [
            "philippines"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇵🇰",
        description: "flag: Pakistan",
        category: "Flags",
        aliases: [
            "pakistan"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇵🇱",
        description: "flag: Poland",
        category: "Flags",
        aliases: [
            "poland"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇵🇲",
        description: "flag: St. Pierre & Miquelon",
        category: "Flags",
        aliases: [
            "st_pierre_miquelon"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.0"
    },
    {
        emoji: "🇵🇳",
        description: "flag: Pitcairn Islands",
        category: "Flags",
        aliases: [
            "pitcairn_islands"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.0"
    },
    {
        emoji: "🇵🇷",
        description: "flag: Puerto Rico",
        category: "Flags",
        aliases: [
            "puerto_rico"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇵🇸",
        description: "flag: Palestinian Territories",
        category: "Flags",
        aliases: [
            "palestinian_territories"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇵🇹",
        description: "flag: Portugal",
        category: "Flags",
        aliases: [
            "portugal"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇵🇼",
        description: "flag: Palau",
        category: "Flags",
        aliases: [
            "palau"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇵🇾",
        description: "flag: Paraguay",
        category: "Flags",
        aliases: [
            "paraguay"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇶🇦",
        description: "flag: Qatar",
        category: "Flags",
        aliases: [
            "qatar"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇷🇪",
        description: "flag: Réunion",
        category: "Flags",
        aliases: [
            "reunion"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.0"
    },
    {
        emoji: "🇷🇴",
        description: "flag: Romania",
        category: "Flags",
        aliases: [
            "romania"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇷🇸",
        description: "flag: Serbia",
        category: "Flags",
        aliases: [
            "serbia"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇷🇺",
        description: "flag: Russia",
        category: "Flags",
        aliases: [
            "ru"
        ],
        tags: [
            "russia"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🇷🇼",
        description: "flag: Rwanda",
        category: "Flags",
        aliases: [
            "rwanda"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇸🇦",
        description: "flag: Saudi Arabia",
        category: "Flags",
        aliases: [
            "saudi_arabia"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇸🇧",
        description: "flag: Solomon Islands",
        category: "Flags",
        aliases: [
            "solomon_islands"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇸🇨",
        description: "flag: Seychelles",
        category: "Flags",
        aliases: [
            "seychelles"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇸🇩",
        description: "flag: Sudan",
        category: "Flags",
        aliases: [
            "sudan"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇸🇪",
        description: "flag: Sweden",
        category: "Flags",
        aliases: [
            "sweden"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇸🇬",
        description: "flag: Singapore",
        category: "Flags",
        aliases: [
            "singapore"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇸🇭",
        description: "flag: St. Helena",
        category: "Flags",
        aliases: [
            "st_helena"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.0"
    },
    {
        emoji: "🇸🇮",
        description: "flag: Slovenia",
        category: "Flags",
        aliases: [
            "slovenia"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇸🇯",
        description: "flag: Svalbard & Jan Mayen",
        category: "Flags",
        aliases: [
            "svalbard_jan_mayen"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🇸🇰",
        description: "flag: Slovakia",
        category: "Flags",
        aliases: [
            "slovakia"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇸🇱",
        description: "flag: Sierra Leone",
        category: "Flags",
        aliases: [
            "sierra_leone"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇸🇲",
        description: "flag: San Marino",
        category: "Flags",
        aliases: [
            "san_marino"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇸🇳",
        description: "flag: Senegal",
        category: "Flags",
        aliases: [
            "senegal"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇸🇴",
        description: "flag: Somalia",
        category: "Flags",
        aliases: [
            "somalia"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇸🇷",
        description: "flag: Suriname",
        category: "Flags",
        aliases: [
            "suriname"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇸🇸",
        description: "flag: South Sudan",
        category: "Flags",
        aliases: [
            "south_sudan"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇸🇹",
        description: "flag: São Tomé & Príncipe",
        category: "Flags",
        aliases: [
            "sao_tome_principe"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇸🇻",
        description: "flag: El Salvador",
        category: "Flags",
        aliases: [
            "el_salvador"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇸🇽",
        description: "flag: Sint Maarten",
        category: "Flags",
        aliases: [
            "sint_maarten"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇸🇾",
        description: "flag: Syria",
        category: "Flags",
        aliases: [
            "syria"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇸🇿",
        description: "flag: Eswatini",
        category: "Flags",
        aliases: [
            "swaziland"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇹🇦",
        description: "flag: Tristan da Cunha",
        category: "Flags",
        aliases: [
            "tristan_da_cunha"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🇹🇨",
        description: "flag: Turks & Caicos Islands",
        category: "Flags",
        aliases: [
            "turks_caicos_islands"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇹🇩",
        description: "flag: Chad",
        category: "Flags",
        aliases: [
            "chad"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.0"
    },
    {
        emoji: "🇹🇫",
        description: "flag: French Southern Territories",
        category: "Flags",
        aliases: [
            "french_southern_territories"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇹🇬",
        description: "flag: Togo",
        category: "Flags",
        aliases: [
            "togo"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇹🇭",
        description: "flag: Thailand",
        category: "Flags",
        aliases: [
            "thailand"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇹🇯",
        description: "flag: Tajikistan",
        category: "Flags",
        aliases: [
            "tajikistan"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇹🇰",
        description: "flag: Tokelau",
        category: "Flags",
        aliases: [
            "tokelau"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.0"
    },
    {
        emoji: "🇹🇱",
        description: "flag: Timor-Leste",
        category: "Flags",
        aliases: [
            "timor_leste"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇹🇲",
        description: "flag: Turkmenistan",
        category: "Flags",
        aliases: [
            "turkmenistan"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇹🇳",
        description: "flag: Tunisia",
        category: "Flags",
        aliases: [
            "tunisia"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇹🇴",
        description: "flag: Tonga",
        category: "Flags",
        aliases: [
            "tonga"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇹🇷",
        description: "flag: Turkey",
        category: "Flags",
        aliases: [
            "tr"
        ],
        tags: [
            "turkey"
        ],
        unicodeVersion: "8.0",
        iosVersion: "9.1"
    },
    {
        emoji: "🇹🇹",
        description: "flag: Trinidad & Tobago",
        category: "Flags",
        aliases: [
            "trinidad_tobago"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇹🇻",
        description: "flag: Tuvalu",
        category: "Flags",
        aliases: [
            "tuvalu"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇹🇼",
        description: "flag: Taiwan",
        category: "Flags",
        aliases: [
            "taiwan"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.0"
    },
    {
        emoji: "🇹🇿",
        description: "flag: Tanzania",
        category: "Flags",
        aliases: [
            "tanzania"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇺🇦",
        description: "flag: Ukraine",
        category: "Flags",
        aliases: [
            "ukraine"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇺🇬",
        description: "flag: Uganda",
        category: "Flags",
        aliases: [
            "uganda"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇺🇲",
        description: "flag: U.S. Outlying Islands",
        category: "Flags",
        aliases: [
            "us_outlying_islands"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🇺🇳",
        description: "flag: United Nations",
        category: "Flags",
        aliases: [
            "united_nations"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🇺🇸",
        description: "flag: United States",
        category: "Flags",
        aliases: [
            "us"
        ],
        tags: [
            "flag",
            "united",
            "america"
        ],
        unicodeVersion: "6.0",
        iosVersion: "6.0"
    },
    {
        emoji: "🇺🇾",
        description: "flag: Uruguay",
        category: "Flags",
        aliases: [
            "uruguay"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇺🇿",
        description: "flag: Uzbekistan",
        category: "Flags",
        aliases: [
            "uzbekistan"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇻🇦",
        description: "flag: Vatican City",
        category: "Flags",
        aliases: [
            "vatican_city"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.0"
    },
    {
        emoji: "🇻🇨",
        description: "flag: St. Vincent & Grenadines",
        category: "Flags",
        aliases: [
            "st_vincent_grenadines"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇻🇪",
        description: "flag: Venezuela",
        category: "Flags",
        aliases: [
            "venezuela"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇻🇬",
        description: "flag: British Virgin Islands",
        category: "Flags",
        aliases: [
            "british_virgin_islands"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇻🇮",
        description: "flag: U.S. Virgin Islands",
        category: "Flags",
        aliases: [
            "us_virgin_islands"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇻🇳",
        description: "flag: Vietnam",
        category: "Flags",
        aliases: [
            "vietnam"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇻🇺",
        description: "flag: Vanuatu",
        category: "Flags",
        aliases: [
            "vanuatu"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇼🇫",
        description: "flag: Wallis & Futuna",
        category: "Flags",
        aliases: [
            "wallis_futuna"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.0"
    },
    {
        emoji: "🇼🇸",
        description: "flag: Samoa",
        category: "Flags",
        aliases: [
            "samoa"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇽🇰",
        description: "flag: Kosovo",
        category: "Flags",
        aliases: [
            "kosovo"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇾🇪",
        description: "flag: Yemen",
        category: "Flags",
        aliases: [
            "yemen"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇾🇹",
        description: "flag: Mayotte",
        category: "Flags",
        aliases: [
            "mayotte"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "9.0"
    },
    {
        emoji: "🇿🇦",
        description: "flag: South Africa",
        category: "Flags",
        aliases: [
            "south_africa"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇿🇲",
        description: "flag: Zambia",
        category: "Flags",
        aliases: [
            "zambia"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🇿🇼",
        description: "flag: Zimbabwe",
        category: "Flags",
        aliases: [
            "zimbabwe"
        ],
        tags: [],
        unicodeVersion: "6.0",
        iosVersion: "8.3"
    },
    {
        emoji: "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
        description: "flag: England",
        category: "Flags",
        aliases: [
            "england"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🏴󠁧󠁢󠁳󠁣󠁴󠁿",
        description: "flag: Scotland",
        category: "Flags",
        aliases: [
            "scotland"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    },
    {
        emoji: "🏴󠁧󠁢󠁷󠁬󠁳󠁿",
        description: "flag: Wales",
        category: "Flags",
        aliases: [
            "wales"
        ],
        tags: [],
        unicodeVersion: "11.0",
        iosVersion: "12.1"
    }, 
];
const rsAstralRange = "\\ud800-\\udfff", rsComboMarksRange = "\\u0300-\\u036f", reComboHalfMarksRange = "\\ufe20-\\ufe2f", rsComboSymbolsRange = "\\u20d0-\\u20ff", rsComboRange = rsComboMarksRange + reComboHalfMarksRange + rsComboSymbolsRange, rsDingbatRange = "\\u2700-\\u27bf", rsLowerRange = "a-z\\xdf-\\xf6\\xf8-\\xff", rsMathOpRange = "\\xac\\xb1\\xd7\\xf7", rsNonCharRange = "\\x00-\\x2f\\x3a-\\x40\\x5b-\\x60\\x7b-\\xbf", rsPunctuationRange = "\\u2000-\\u206f", rsSpaceRange = " \\t\\x0b\\f\\xa0\\ufeff\\n\\r\\u2028\\u2029\\u1680\\u180e\\u2000\\u2001\\u2002\\u2003\\u2004\\u2005\\u2006\\u2007\\u2008\\u2009\\u200a\\u202f\\u205f\\u3000", rsUpperRange = "A-Z\\xc0-\\xd6\\xd8-\\xde", rsVarRange = "\\ufe0e\\ufe0f", rsBreakRange = rsMathOpRange + rsNonCharRange + rsPunctuationRange + rsSpaceRange;
const rsApos = "['\u2019]", rsAstral = "[" + rsAstralRange + "]", rsBreak = "[" + rsBreakRange + "]", rsCombo = "[" + rsComboRange + "]", rsDigits = "\\d+", rsDingbat = "[" + rsDingbatRange + "]", rsLower = "[" + rsLowerRange + "]", rsMisc = "[^" + rsAstralRange + rsBreakRange + rsDigits + rsDingbatRange + rsLowerRange + rsUpperRange + "]", rsFitz = "\\ud83c[\\udffb-\\udfff]", rsModifier = "(?:" + rsCombo + "|" + rsFitz + ")", rsNonAstral = "[^" + rsAstralRange + "]", rsRegional = "(?:\\ud83c[\\udde6-\\uddff]){2}", rsSurrPair = "[\\ud800-\\udbff][\\udc00-\\udfff]", rsUpper = "[" + rsUpperRange + "]", rsZWJ = "\\u200d";
const rsMiscLower = "(?:" + rsLower + "|" + rsMisc + ")", rsMiscUpper = "(?:" + rsUpper + "|" + rsMisc + ")", rsOptContrLower = "(?:" + rsApos + "(?:d|ll|m|re|s|t|ve))?", rsOptContrUpper = "(?:" + rsApos + "(?:D|LL|M|RE|S|T|VE))?", reOptMod = rsModifier + "?", rsOptconst = "[" + rsVarRange + "]?", rsOptJoin = "(?:" + rsZWJ + "(?:" + [
    rsNonAstral,
    rsRegional,
    rsSurrPair
].join("|") + ")" + rsOptconst + reOptMod + ")*", rsOrdLower = "\\d*(?:1st|2nd|3rd|(?![123])\\dth)(?=\\b|[A-Z_])", rsOrdUpper = "\\d*(?:1ST|2ND|3RD|(?![123])\\dTH)(?=\\b|[a-z_])", rsSeq = rsOptconst + reOptMod + rsOptJoin, rsEmoji = "(?:" + [
    rsDingbat,
    rsRegional,
    rsSurrPair
].join("|") + ")" + rsSeq, rsSymbol = "(?:" + [
    rsNonAstral + rsCombo + "?",
    rsCombo,
    rsRegional,
    rsSurrPair,
    rsAstral, 
].join("|") + ")";
const reApos = new RegExp(rsApos, "g");
const reComboMark = new RegExp(rsCombo, "g");
const reUnicode = new RegExp(rsFitz + "(?=" + rsFitz + ")|" + rsSymbol + rsSeq, "g");
const reEmoji = new RegExp(rsEmoji, "g");
const reUnicodeWord = new RegExp([
    rsUpper + "?" + rsLower + "+" + rsOptContrLower + "(?=" + [
        rsBreak,
        rsUpper,
        "$"
    ].join("|") + ")",
    rsMiscUpper + "+" + rsOptContrUpper + "(?=" + [
        rsBreak,
        rsUpper + rsMiscLower,
        "$"
    ].join("|") + ")",
    rsUpper + "?" + rsMiscLower + "+" + rsOptContrLower,
    rsUpper + "+" + rsOptContrUpper,
    rsOrdUpper,
    rsOrdLower,
    rsDigits,
    rsEmoji, 
].join("|"), "g");
const reHasUnicode = new RegExp("[" + rsZWJ + rsAstralRange + rsComboRange + rsVarRange + "]");
const reEmojiName = /:([a-zA-Z0-9_\-\+]+):/g;
const NON_SPACING_MARK = String.fromCharCode(65039);
const reNonSpacing = new RegExp(NON_SPACING_MARK, "g");
function stripNSB(code) {
    return code.replace(reNonSpacing, "");
}
function stripColons(str) {
    var colonIndex = str.indexOf(":");
    if (colonIndex > -1) {
        if (colonIndex === str.length - 1) {
            str = str.substring(0, colonIndex);
            return stripColons(str);
        } else {
            str = str.substr(colonIndex + 1);
            return stripColons(str);
        }
    }
    return str;
}
function wrapColons(str) {
    return str.length > 0 ? ":" + str + ":" : str;
}
const byAlias = Object.fromEntries(emojis.map((emoji)=>emoji.aliases.map((alias)=>[
            alias,
            emoji
        ]
    )
).flat());
const byCode = Object.fromEntries(emojis.map((emoji)=>{
    return [
        stripNSB(emoji.emoji),
        emoji
    ];
}));
function get(alias) {
    return byAlias[stripColons(alias)]?.emoji;
}
function emojify(str) {
    if (!str) return "";
    return str.split(reEmojiName).map((s1, i)=>{
        if (i % 2 === 0) return s1;
        let emoji = get(s1);
        if (!emoji) emoji = wrapColons(s1);
        return emoji;
    }).join("");
}
document.addEventListener("DOMContentLoaded", ()=>{
    const STATUS = document.getElementById("status");
    const MESSAGES = document.getElementById("messages");
    const FORM = document.getElementById("form");
    const MESSAGE = document.getElementById("message");
    async function listen() {
        STATUS.innerText = "🟡 Connecting...";
        try {
            const res = await fetch("/listen");
            STATUS.innerText = "🟢 Connected";
            const reader1 = readerFromStreamReader(res.body.getReader());
            const lines = readLines(reader1);
            for await (const line of lines){
                const { kind , data  } = JSON.parse(line);
                switch(kind){
                    case "msg":
                        {
                            handleMessage(data);
                            break;
                        }
                    case "keepalive":
                        console.log("keepalive");
                        break;
                    default: break;
                }
            }
        } catch (err) {
            console.error(err);
        } finally{
            STATUS.innerText = "🔴 Disconnected";
        }
    }
    function handleMessage(message2) {
        const { user , body  } = message2;
        const li = document.createElement("li");
        const name = document.createElement("b");
        name.innerText = `[${user}] `;
        const contents = document.createElement("span");
        contents.innerText = emojify(body);
        li.appendChild(name);
        li.appendChild(contents);
        MESSAGES.appendChild(li);
    }
    let submitting = false;
    FORM.onsubmit = (e)=>{
        e.preventDefault();
        e.stopPropagation();
        const body = MESSAGE.value;
        if (submitting || body === "") return;
        const message2 = JSON.stringify({
            body
        });
        FORM.disabled = true;
        submitting = true;
        fetch("/send", {
            body: message2,
            method: "POST"
        }).then((r)=>r.text()
        ).then((txt)=>{
            MESSAGE.disabled = false;
            submitting = false;
            FORM.reset();
            console.log(txt);
        });
        return false;
    };
    async function main() {
        while(true){
            await listen();
            await delay(1000);
        }
    }
    main();
});

