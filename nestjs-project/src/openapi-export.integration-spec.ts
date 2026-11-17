import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportSpec } from './openapi-export';

describe('exportSpec (integration)', () => {
  let outputPath: string;
  let document: Record<string, unknown>;

  beforeAll(async () => {
    outputPath = join(tmpdir(), `openapi-test-${Date.now()}.json`);
    await exportSpec(outputPath);
    document = JSON.parse(readFileSync(outputPath, 'utf-8')) as Record<
      string,
      unknown
    >;
  }, 30_000);

  it('exports a valid OpenAPI 3.x document', () => {
    expect(document.openapi).toMatch(/^3\./);
  });

  it('sets info.title to "StreamTube API"', () => {
    const info = document.info as Record<string, unknown>;
    expect(info.title).toBe('StreamTube API');
  });

  it('sets info.version to "1.0"', () => {
    const info = document.info as Record<string, unknown>;
    expect(info.version).toBe('1.0');
  });

  it('includes access-token Bearer security scheme', () => {
    const components = document.components as Record<string, unknown>;
    const schemes = components.securitySchemes as Record<
      string,
      Record<string, unknown>
    >;
    expect(schemes['access-token']).toMatchObject({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
  });

  it('includes non-empty components.schemas from DTO inference', () => {
    const components = document.components as Record<string, unknown>;
    const schemas = components.schemas as Record<string, unknown>;
    expect(Object.keys(schemas).length).toBeGreaterThan(0);
  });

  it('includes ApiErrorEnvelope schema with expected properties', () => {
    const components = document.components as Record<string, unknown>;
    const schemas = components.schemas as Record<
      string,
      Record<string, unknown>
    >;
    expect(schemas['ApiErrorEnvelope']).toBeDefined();
    const props = schemas['ApiErrorEnvelope'].properties as Record<
      string,
      unknown
    >;
    expect(props).toHaveProperty('statusCode');
    expect(props).toHaveProperty('error');
    expect(props).toHaveProperty('message');
    expect(props).toHaveProperty('code');
  });

  it('has at least one path with a 401 response referencing ApiErrorEnvelope', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const apiErrorRef = '#/components/schemas/ApiErrorEnvelope';

    const hasRef = Object.values(paths).some((methods) =>
      Object.values(methods).some((operation) => {
        const responses = operation.responses as Record<
          string,
          Record<string, unknown>
        >;
        const r401 = responses?.['401'];
        if (!r401) return false;
        const content = r401.content as Record<string, Record<string, unknown>>;
        const jsonContent = content?.['application/json'];
        const schema = jsonContent?.schema as Record<string, unknown>;
        return schema?.['$ref'] === apiErrorRef;
      }),
    );

    expect(hasRef).toBe(true);
  });

  it('protected auth endpoints include access-token security requirement', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const protectedPaths = [
      { path: '/auth/logout', method: 'post' },
      { path: '/auth/me', method: 'get' },
    ];

    for (const { path, method } of protectedPaths) {
      const operation = paths[path]?.[method];
      expect(operation).toBeDefined();
      const security = operation?.security as Array<Record<string, unknown>>;
      expect(security).toBeDefined();
      expect(security.some((req) => 'access-token' in req)).toBe(true);
    }
  });

  it('all auth endpoints have a non-empty summary', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const authPaths = Object.entries(paths).filter(([p]) =>
      p.startsWith('/auth/'),
    );

    expect(authPaths.length).toBeGreaterThan(0);

    for (const [, methods] of authPaths) {
      for (const operation of Object.values(methods)) {
        expect(typeof operation.summary).toBe('string');
        expect((operation.summary as string).length).toBeGreaterThan(0);
      }
    }
  });

  describe('video endpoints', () => {
    type Operation = {
      tags?: string[];
      responses: Record<string, Record<string, unknown>>;
      security?: Array<Record<string, unknown>>;
    };
    const paths = (): Record<string, Record<string, Operation>> =>
      document.paths as Record<string, Record<string, Operation>>;

    // Contract of `### API Contracts` (phase-03-videos): path, method, and the
    // response codes each operation must document.
    const VIDEO_OPERATIONS = [
      { path: '/videos', method: 'post', codes: ['201', '400', '401'] },
      {
        path: '/videos/{public_id}',
        method: 'get',
        codes: ['200', '401', '404'],
      },
      {
        path: '/videos/{public_id}/upload/parts',
        method: 'post',
        codes: ['200', '400', '401', '404', '409'],
      },
      {
        path: '/videos/{public_id}/upload/completion',
        method: 'post',
        codes: ['200', '202', '400', '401', '404', '422'],
      },
      {
        path: '/videos/{public_id}/stream',
        method: 'get',
        codes: ['302', '401', '404', '409'],
      },
      {
        path: '/videos/{public_id}/download',
        method: 'get',
        codes: ['302', '401', '404', '409'],
      },
    ];

    it.each(VIDEO_OPERATIONS)(
      '$method $path is under the videos tag with its documented responses',
      ({ path, method, codes }) => {
        const operation = paths()[path]?.[method];

        expect(operation).toBeDefined();
        expect(operation.tags).toContain('videos');
        expect(Object.keys(operation.responses)).toEqual(
          expect.arrayContaining(codes),
        );
      },
    );

    it.each(VIDEO_OPERATIONS)(
      '$method $path requires the access-token and references ApiErrorEnvelope on errors',
      ({ path, method, codes }) => {
        const operation = paths()[path][method];

        expect(operation.security?.some((r) => 'access-token' in r)).toBe(true);
        for (const code of codes.filter((c) => Number(c) >= 400)) {
          expect(JSON.stringify(operation.responses[code])).toContain(
            '#/components/schemas/ApiErrorEnvelope',
          );
        }
      },
    );

    it('documents the Location header of the stream and download redirects', () => {
      for (const path of [
        '/videos/{public_id}/stream',
        '/videos/{public_id}/download',
      ]) {
        const headers = paths()[path].get.responses['302'].headers as Record<
          string,
          unknown
        >;
        expect(headers).toHaveProperty('Location');
      }
    });
  });
});
