import { FunctionDeclaration, Type } from "@google/genai";
import schema from "./schema.json";

/**
 * The function declaration for proposing file renames.
 * This is used by the Gemini API to understand the tool's capabilities.
 */
export const proposeFileRenamesTool: FunctionDeclaration = {
  name: schema.name,
  description: schema.description,
  parameters: {
    type: Type.OBJECT,
    properties: {
      fileList: {
        type: Type.ARRAY,
        description: schema.parameters.properties.fileList.description,
        items: {
          type: Type.OBJECT,
          properties: {
            fileId: {
              type: Type.STRING,
              description: schema.parameters.properties.fileList.items.properties.fileId.description
            },
            currentName: {
              type: Type.STRING,
              description: schema.parameters.properties.fileList.items.properties.currentName.description
            },
            proposedName: {
              type: Type.STRING,
              description: "The suggested new filename."
            },
            reasoning: {
              type: Type.STRING,
              description: "The reason for this specific name suggestion."
            }
          },
          required: ["fileId", "currentName", "proposedName", "reasoning"]
        }
      },
      namingConvention: {
        type: Type.STRING,
        description: schema.parameters.properties.namingConvention.description
      }
    },
    required: schema.parameters.required
  }
};

/**
 * Interface for the file list items.
 */
export interface DriveFile {
  fileId: string;
  currentName: string;
  mimeType?: string;
  content?: string;
  sizeBytes?: number;
  iconUrl?: string;
  source?: "apps-script" | "picker" | "manual";
}

/**
 * Interface for the response from Apps Script server-side functions.
 */
export interface AppsScriptResponse {
  success: boolean;
  files?: DriveFile[];
  error?: string;
}

/**
 * Interface for the response from the renameFile function.
 */
export interface RenameResponse {
  success: boolean;
  fileId?: string;
  newName?: string;
  error?: string;
}

/**
 * Interface for individual batch rename request items sent to batchRenameFiles.
 */
export interface BatchRenameItem {
  id: string;
  fileId?: string;
  originalName: string;
  proposedName: string;
  folderId?: string;
}

/**
 * Result for an individual item in a batch rename operation.
 */
export interface BatchRenameItemResult {
  index?: number;
  id?: string;
  originalName?: string;
  newName?: string;
  success: boolean;
  message?: string;
  error?: string;
}

/**
 * Interface for the response from batchRenameFiles.
 */
export interface BatchRenameResponse {
  success: boolean;
  totalRequested?: number;
  totalSuccess?: number;
  totalFailed?: number;
  results?: BatchRenameItemResult[];
  message?: string;
}

/**
 * Interface for the rename suggestions returned by the tool.
 */
export interface RenameSuggestion {
  fileId: string;
  currentName: string;
  proposedName: string;
  reasoning: string;
}
