import type { z } from "zod"
import type {
  AssetSchema,
  BlockNodeSchema,
  BranchNodeSchema,
  BreakNodeSchema,
  ConsentNodeSchema,
  EndNodeSchema,
  ExperimentSchema,
  InstructionsNodeSchema,
  MetaSchema,
  NodeSchema,
  PhaseSchema,
  RandomizerArmSchema,
  RandomizerNodeSchema,
  ResponseSchema,
  SettingsSchema,
  SurveyNodeSchema,
  SurveyQuestionSchema,
  TrialNodeSchema,
  VariableSchema,
} from "./schema"

export type Experiment = z.infer<typeof ExperimentSchema>
export type Meta = z.infer<typeof MetaSchema>
export type Settings = z.infer<typeof SettingsSchema>
export type Asset = z.infer<typeof AssetSchema>
export type Variable = z.infer<typeof VariableSchema>
export type Phase = z.infer<typeof PhaseSchema>
export type Response = z.infer<typeof ResponseSchema>
export type Node = z.infer<typeof NodeSchema>
export type ConsentNode = z.infer<typeof ConsentNodeSchema>
export type InstructionsNode = z.infer<typeof InstructionsNodeSchema>
export type TrialNode = z.infer<typeof TrialNodeSchema>
export type BlockNode = z.infer<typeof BlockNodeSchema>
export type BranchNode = z.infer<typeof BranchNodeSchema>
export type RandomizerArm = z.infer<typeof RandomizerArmSchema>
export type RandomizerNode = z.infer<typeof RandomizerNodeSchema>
export type SurveyQuestion = z.infer<typeof SurveyQuestionSchema>
export type SurveyNode = z.infer<typeof SurveyNodeSchema>
export type BreakNode = z.infer<typeof BreakNodeSchema>
export type EndNode = z.infer<typeof EndNodeSchema>
