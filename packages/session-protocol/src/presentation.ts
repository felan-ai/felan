import { Type, type Static } from 'typebox';
import { CounterSchema, IdSchema, JsonValueSchema } from './schema.js';


export const PresentationEventSchema = Type.Object({
  v: Type.Literal(1), session: IdSchema,
  presentationEvent: Type.Object({ sequence: CounterSchema,
    data: JsonValueSchema }, { additionalProperties: false }),
}, { additionalProperties: false });
export type PresentationEvent = Static<typeof PresentationEventSchema>;
