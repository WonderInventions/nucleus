import * as cp from 'child_process';
import * as fs from 'fs/promises';
import { createReadStream, ReadStream } from 'fs';
import * as http from 'http';
import * as path from 'path';

const serveHandler = require('serve-handler');

const filesRoot = path.resolve(__dirname, 'fixtures', '.files');
const BASE_URL = 'http://localhost:8987/rest';

let child: cp.ChildProcess | null = null;
let server: http.Server | null = null;

const pathExists = async (p: string): Promise<boolean> => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

const resetMySQLDatabase = async () => {
  return new Promise<void>((resolve, reject) => {
    cp.exec('mysql -u root -e "DROP DATABASE IF EXISTS nucleus_test;" && mysql -u root -e "CREATE DATABASE IF NOT EXISTS nucleus_test;"', (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
};

export const startTestNucleus = async function (timeout = 7000) {
  if (child !== null || server !== null) {
    throw new Error('Nucleus is already running, something went wrong in the tests');
  }
  await fs.rm(path.resolve(__dirname, 'fixtures', '.files'), { recursive: true, force: true });
  await fs.rm(path.resolve(__dirname, 'fixtures', 'test.sqlite'), { force: true });
  await resetMySQLDatabase();

  child = cp.spawn(
    process.execPath,
    [
      path.resolve(__dirname, '../../lib/index.js'),
      path.resolve(__dirname, './fixtures/test.config.js'),
    ],
    {
      cwd: path.resolve(__dirname, '..'),
      env: Object.assign({}, process.env, {
        DEBUG: 'nucleus*',
        UNSAFELY_DISABLE_NUCLEUS_AUTH: 'true',
      }),
      stdio: 'inherit',
    },
  );
  server = http.createServer((req, res) => {
    return serveHandler(req, res, {
      public: path.resolve(__dirname, 'fixtures/.files'),
    });
  });
  await new Promise<void>(resolve => server!.listen(9999, () => resolve()));
  let alive = false;
  const startTime = Date.now();
  while (!alive) {
    if (Date.now() - startTime > timeout) {
      throw new Error('Timed out waiting for Nucleus to start');
    }
    try {
      const resp = await fetch(`${BASE_URL}/healthcheck`);
      if (resp.ok) {
        alive = true;
      }
    } catch {
      // Ignore
      await new Promise(r => setTimeout(r, 100));
    }
  }
};

export const stopTestNucleus = async () => {
  if (child) {
    const waiter = new Promise<void>(resolve => child!.on('exit', () => resolve()));
    child.kill();
    await waiter;
    child = null;
  }
  if (server) {
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = null;
  }
  await fs.rm(path.resolve(__dirname, 'fixtures', '.files'), { recursive: true, force: true });
  await fs.rm(path.resolve(__dirname, 'fixtures', 'test.sqlite'), { force: true });
};

// HTTP request helper using native fetch
interface RequestResponse {
  status: number;
  body: any;
  headers: Headers;
}

class RequestBuilder {
  private baseUrl: string;
  private method: string = 'GET';
  private _path: string = '';
  private _body: any = null;
  private _contentType: string | null = null;
  private _fields: Record<string, string> = {};
  private _attachments: { name: string; stream: ReadStream; filename: string }[] = [];

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  get(path: string): RequestBuilder {
    this.method = 'GET';
    this._path = path;
    return this;
  }

  post(path: string): RequestBuilder {
    this.method = 'POST';
    this._path = path;
    return this;
  }

  del(path: string): RequestBuilder {
    this.method = 'DELETE';
    this._path = path;
    return this;
  }

  send(body?: any): Promise<RequestResponse> {
    if (body !== undefined) {
      this._body = body;
      this._contentType = 'application/json';
    }
    return this.execute();
  }

  field(name: string, value: string): RequestBuilder {
    this._fields[name] = value;
    return this;
  }

  attach(name: string, stream: ReadStream): RequestBuilder {
    const filePath = (stream as any).path as string;
    this._attachments.push({ name, stream, filename: path.basename(filePath) });
    return this;
  }

  private async execute(): Promise<RequestResponse> {
    const url = `${this.baseUrl}${this._path}`;
    const options: RequestInit = {
      method: this.method,
    };

    // Handle multipart form data (attachments)
    if (this._attachments.length > 0 || Object.keys(this._fields).length > 0) {
      const formData = new FormData();

      for (const [key, value] of Object.entries(this._fields)) {
        formData.append(key, value);
      }

      for (const attachment of this._attachments) {
        const buffer = await fs.readFile((attachment.stream as any).path);
        const blob = new Blob([buffer]);
        formData.append(attachment.name, blob, attachment.filename);
      }

      options.body = formData;
    } else if (this._body !== null) {
      options.body = JSON.stringify(this._body);
      options.headers = {
        'Content-Type': 'application/json',
      };
    }

    const response = await fetch(url, options);
    let body: any;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      body = await response.json();
    } else {
      body = await response.text();
    }

    return {
      status: response.status,
      body,
      headers: response.headers,
    };
  }
}

export const request = {
  get(path: string) {
    return new RequestBuilder(BASE_URL).get(path);
  },
  post(path: string) {
    return new RequestBuilder(BASE_URL).post(path);
  },
  del(path: string) {
    return new RequestBuilder(BASE_URL).del(path);
  },
};

// Simple test store for checking local files during tests
export const store = {
  async hasFile(filePath: string): Promise<boolean> {
    return pathExists(path.join(filesRoot, filePath));
  },
  async getFile(filePath: string): Promise<Buffer> {
    return fs.readFile(path.join(filesRoot, filePath));
  },
};

export const createApp = async (): Promise<NucleusApp> => {
  const response = await request
    .post('/app')
    .field('name', 'Test App')
    .attach('icon', createReadStream(path.resolve(__dirname, 'fixtures', 'icon.png')))
    .send();

  if (response.status !== 200) {
    console.error('createApp failed:', response.status, response.body);
  }
  return response.body;
};
