import { z } from "zod";

export const cancelActionSchema = z.object({
  id: z.uuid(),
  reason: z.string().trim().min(1),
});
