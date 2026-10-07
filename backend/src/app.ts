import { beginOperation, operationIssue } from './storage/operation-progress';
import { MAX_MULTIPART_BYTES } from './storage/upload-limits';
import 'reflect-metadata';
import { Module, Catch, ExceptionFilter, ArgumentsHost, HttpException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { Config } from './config';
import { database } from './db';
import { ShopService } from './modules/shop.service';
import { Auth, Context } from './modules/auth';
import { ShopController, MockController, AdminController } from './modules/controllers';
import { AccountController } from './commerce/accounts';
import { CommerceAdminController, AnalyticsController } from './commerce/management';
import { PurchaseFileController } from './storage/controller';
import { ChatController, Messaging } from './commerce/messaging';
@Catch()
class Errors implements ExceptionFilter {
    catch(error: any, host: ArgumentsHost) {
        const req = host.switchToHttp().getRequest();
        const res = host.switchToHttp().getResponse();
        const status = error instanceof HttpException ? error.getStatus() : error?.code === 'P2002' ? 409 : error?.code === 'P2025' ? 404 : 500;
        const details = error instanceof HttpException ? error.getResponse() : undefined;
        const object = details !== null && typeof details === 'object' ? details as any : undefined;
        const message = status === 500 ? 'The operation could not be completed' : status === 409 ? 'This record already exists' : object?.message || details || 'Record not found';
        if (status === 429)
            res.setHeader('Retry-After', '60');
        operationIssue(req, object?.code || (status === 500 ? 'INTERNAL_ERROR' : 'REQUEST_REJECTED'), object?.reason || (typeof message === 'string' ? message : 'Request failed'));
        res.status(status).json({ requestId: req.requestId, code: object?.code || (status === 413 ? 'FILE_TOO_LARGE' : status === 500 ? 'INTERNAL_ERROR' : status === 409 ? 'CONFLICT' : 'REQUEST_REJECTED'), message, fields: object?.fields, reason: object?.reason });
    }
}
export async function createApp(config: Config) {
    await fs.mkdir(config.STORAGE_ROOT, { recursive: true });
    await fs.mkdir(config.PURCHASE_ROOT, { recursive: true });
    const db = database(config.DATABASE_URL);
    await db.$connect();
    const shop = new ShopService(db, config), auth = new Auth(db, config);
    @Module({ controllers: [ShopController, AdminController, AccountController, CommerceAdminController, AnalyticsController, PurchaseFileController, ChatController, ...(config.APP_ENV !== 'production' && config.PAYMENT_MODE === 'mock' ? [MockController] : [])], providers: [{ provide: ShopService, useValue: shop }, { provide: Auth, useValue: auth }, { provide: Messaging, useValue: new Messaging(shop, auth) }] })
    class AppModule {
    }
    const app = await NestFactory.create(AppModule, { rawBody: true, logger: ['error', 'warn'], bodyParser: true });
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new Errors());
    app.use(cookieParser());
    app.use(helmet());
    app.enableCors({ origin: config.PUBLIC_ORIGIN, credentials: true, methods: ['GET', 'POST', 'PATCH', 'DELETE'], allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-Operation-Id'] });
    app.use(async (req: Context, res: any, next: any) => {
        req.requestId = randomUUID();
        res.setHeader('X-Request-Id', req.requestId);
        res.setHeader('Cache-Control', 'no-store, private');
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        const path = req.path.replace(/^\/api\/v1/, '');
        try {
            if (path.startsWith('/health/'))
                return next();
            await auth.rate(req, 'api-ip', 600);
            await auth.load(req);
            if (path.startsWith('/payments/webhooks/'))
                return next();
            await auth.development(req, res);
            if (!['/session', '/access', '/access/logout'].includes(path))
                auth.requireAccess(req);
            if (path.startsWith('/openapi'))
                auth.requireAdmin(req, 'ADMIN');
            if (path.startsWith('/admin') && path !== '/admin/login') {
                auth.requireAdmin(req);
                if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) beginOperation(req, res, db);
                await auth.rate(req, 'admin-api', 200);
            }
            const customerRoute = /^\/(products|categories|quotes|previews|orders|downloads|mock|analytics|chat)(\/|$)/.test(path);
            if (customerRoute && !req.admin && !(config.APP_ENV === 'production' && path.startsWith('/mock/')))
                auth.requireCustomer(req);
            if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method))
                auth.csrf(req, path.startsWith('/admin') && path !== '/admin/login');
            // Check upload permissions before Multer buffers bytes.
            if (req.method === 'POST' && /^\/admin\/products\/[^/]+\/current-file$/.test(path)) {
                auth.requireAdmin(req, 'ADMIN');
            }
            if (req.method === 'POST' && req.headers['content-type']?.startsWith('multipart/form-data')) {
                const length = Number(req.headers['content-length'] || 0);
                if (length > (/^\/admin\/products\/[^/]+\/current-file$/.test(path) ? 2 * MAX_MULTIPART_BYTES : MAX_MULTIPART_BYTES))
                    throw new HttpException({ code: 'FILE_TOO_LARGE', message: 'Upload exceeds server budget' }, 413);
                await auth.rate(req, 'upload-ip', 10);
            }
            next();
        }
        catch (e) {
            new Errors().catch(e, { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) } as any);
        }
    });
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('Template Workshop API').setVersion('1.0').addCookieAuth('guest').addCookieAuth('admin').build());
    SwaggerModule.setup('api/v1/openapi', app, document, { useGlobalPrefix: false });
    await app.init();
    return { app, db, shop, auth, document };
}
