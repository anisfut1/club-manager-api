import { z } from "./zod";

/** Une "issue" est dérivée de `matches.emarque_status` (error/needs_review) — pas de table dédiée, voir docs/EMARQUE.md. */
export const IssueDtoSchema = z
  .object({
    matchId: z.string().uuid(),
    numero: z.string().nullable(),
    opponentName: z.string().nullable(),
    matchDatetime: z.string().nullable(),
    emarqueStatus: z.enum(["error", "needs_review"]),
  })
  .openapi("IssueDto");

export type IssueDto = z.infer<typeof IssueDtoSchema>;
