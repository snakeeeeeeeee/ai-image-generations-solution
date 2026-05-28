import type { FastifyReply } from 'fastify';

export type OpenAIErrorType = 'invalid_request_error' | 'server_error' | 'upstream_error';

export interface OpenAIErrorBody {
  error: {
    message: string;
    type: OpenAIErrorType | string;
    code: string;
  };
}

export class AppError extends Error {
  statusCode: number;
  type: OpenAIErrorType;
  code: string;

  constructor(
    message: string,
    {
      statusCode = 500,
      type = 'server_error',
      code = 'internal_error',
      cause
    }: {
      statusCode?: number;
      type?: OpenAIErrorType;
      code?: string;
      cause?: unknown;
    } = {}
  ) {
    super(message, { cause });
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.type = type;
    this.code = code;
  }
}

export function openAIError(message: string, type: OpenAIErrorType | string, code: string): OpenAIErrorBody {
  return {
    error: {
      message,
      type,
      code
    }
  };
}

export function sendAppError(reply: FastifyReply, error: unknown): FastifyReply {
  const statusCode = error instanceof AppError ? error.statusCode : 500;
  const type = error instanceof AppError ? error.type : 'server_error';
  const code = error instanceof AppError ? error.code : 'internal_error';
  const message = error instanceof AppError ? error.message : 'Internal server error';

  return reply.status(statusCode).send(openAIError(message, type, code));
}
