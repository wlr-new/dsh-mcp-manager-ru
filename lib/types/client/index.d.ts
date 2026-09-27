import type { Context as ClientContext } from '@deepseek-ai/cordis';
/** Required services. */
export declare const inject: string[];
/**
 * Register the MCP manager settings card.
 * @param ctx - client root context.
 */
export declare function apply(ctx: ClientContext): void;
