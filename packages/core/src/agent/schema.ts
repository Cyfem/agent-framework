import { z } from 'zod';

import type { ToolParametersSchema } from './types';

const emptyParametersSchema = z.object({});

/** 为没有声明参数的工具提供默认空对象 schema，供本地参数校验使用。 */
export function getDefaultToolParametersSchema(): ToolParametersSchema {
  return emptyParametersSchema;
}
