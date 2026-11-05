import { METHODS } from "node:http";
import { Router, type NextFunction, type RouterOptions } from "express";

// Express 4 não repassa a rejeição de um handler async para o handler de erro: a requisição ficava pendurada
// até o timeout (408). createAsyncRouter devolve um Router comum cujos get/post/.../use embrulham cada handler:
// se ele devolver uma promise rejeitada, o erro vai para next(err). Retorno síncrono e throw síncrono seguem
// o caminho normal do Express. Sub-routers (e apps) passam sem embrulho.

type AnyFunction = (...args: any[]) => unknown;

const ROUTER_METHODS = [...METHODS.map((method) => method.toLowerCase()), "all", "use"];

const isRouterLike = (fn: AnyFunction) => {
  const candidate = fn as unknown as { handle?: unknown; stack?: unknown };
  return typeof candidate.handle === "function" || Array.isArray(candidate.stack);
};

const forwardRejection = (result: unknown, next: NextFunction) => {
  if (!result || typeof (result as PromiseLike<unknown>).then !== "function") return;
  (result as PromiseLike<unknown>).then(undefined, (error: unknown) => {
    // next(undefined) faria o Express seguir em frente como se nada tivesse falhado.
    next(error ?? new Error("Handler async rejeitado sem motivo."));
  });
};

export const wrapAsyncHandler = <T>(handler: T): T => {
  if (typeof handler !== "function") return handler;
  const fn = handler as unknown as AnyFunction;
  if (isRouterLike(fn)) return handler;

  // O Express reconhece handler de erro por aridade 4: a do wrapper precisa ser a mesma.
  if (fn.length === 4) {
    return function asyncErrorHandler(this: unknown, err: unknown, req: unknown, res: unknown, next: NextFunction) {
      forwardRejection(fn.call(this, err, req, res, next), next);
    } as unknown as T;
  }
  return function asyncHandler(this: unknown, req: unknown, res: unknown, next: NextFunction) {
    forwardRejection(fn.call(this, req, res, next), next);
  } as unknown as T;
};

const wrapArgument = (arg: unknown): unknown => (Array.isArray(arg) ? arg.map(wrapArgument) : wrapAsyncHandler(arg));

export function createAsyncRouter(options?: RouterOptions): Router {
  const router = Router(options);
  const target = router as unknown as Record<string, unknown>;
  for (const method of ROUTER_METHODS) {
    const original = target[method];
    if (typeof original !== "function") continue;
    target[method] = function (this: unknown, ...args: unknown[]) {
      return (original as AnyFunction).apply(this, args.map(wrapArgument));
    };
  }
  return router;
}
