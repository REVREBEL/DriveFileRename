/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Main entry point for the Drive Sidebar.
 */
function onHomepage(e) {
  return createRenameCard(e);
}

/**
 * Triggered by the manifest when a user selects files in Drive.
 * Stores IDs in UserProperties for the React app to pick up.
 */
function onItemsSelected(e) {
  if (e && e.drive && e.drive.selectedItems) {
    const selectedIds = e.drive.selectedItems.map(item => item.id);
    PropertiesService.getUserProperties().setProperty('LATEST_SELECTION', JSON.stringify(selectedIds));
  }
  return createRenameCard(e);
}

/**
 * Retrieves the Gemini API Key from Script Properties.
 */
function getGeminiApiKey() {
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY') || '';
  if (!key) console.warn("GEMINI_API_KEY not found in Script Properties.");
  return key;
}

/**
 * Saves or updates the Gemini API Key in Script Properties.
 */
function setGeminiApiKey(key) {
  try {
    if (key && typeof key === 'string' && key.trim().length > 0) {
      PropertiesService.getScriptProperties().setProperty('GEMINI_API_KEY', key.trim());
      return { success: true };
    }
    return { success: false, error: 'Empty or invalid API key' };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

/**
 * Retrieves the preferred Gemini model (defaults to evergreen 'gemini-flash-latest').
 */
function getGeminiModel() {
  return PropertiesService.getScriptProperties().getProperty('GEMINI_MODEL') || 'gemini-flash-latest';
}

/**
 * Sets a custom Gemini model in Script Properties.
 */
function setGeminiModel(modelName) {
  try {
    if (modelName && typeof modelName === 'string') {
      PropertiesService.getScriptProperties().setProperty('GEMINI_MODEL', modelName.trim());
      return { success: true };
    }
    return { success: false, error: 'Empty model name' };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

const GEMINI_API_KEY = getGeminiApiKey();

/**
 * Ensures Drive permissions are requested.
 */
function onOpen(e) {
  try {
    DriveApp.getFiles();
  } catch (e) {
    console.error('Scope initialization failed:', e);
  }
}

/**
 * Creates the sidebar card.
 */
function createRenameCard(e) {
  const card = CardService.newCardBuilder();
  card.setHeader(CardService.newCardHeader()
    .setTitle('DRIVERENAME AI')
    .setSubtitle('Logical File Organization Specialist')
  );

  const section = CardService.newCardSection();
  section.addWidget(CardService.newTextParagraph()
    .setText('<b>SYSTEM STATUS: READY</b><br><br>Select files in your Drive, then launch the overlay to begin AI analysis.'));

  // Development URL (Dev mode reflects code pushes instantly)
  const webAppUrl = "https://script.google.com/macros/s/AKfycbwjUEFK_MA1su9_qIIy3yvIbPyNlHnjN3bp-2VniVo/dev";

  const button = CardService.newTextButton()
    .setText('OPEN AI ASSISTANT')
    .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
    .setBackgroundColor('#1a1a1a')
    .setOpenLink(CardService.newOpenLink()
      .setUrl(webAppUrl)
      .setOpenAs(CardService.OpenAs.OVERLAY)
      .setOnClose(CardService.OnClose.RELOAD_ADD_ON));

  section.addWidget(button);
  card.addSection(section);
  return card.build();
}

/**
 * Retrieves metadata and content for the selected files.
 * Enhanced to handle .txt files and OCR for PDFs.
 */
async function getSelectedFiles() {
  try {
    const storedSelection = PropertiesService.getUserProperties().getProperty("LATEST_SELECTION");

    if (!storedSelection) {
      return {
        success: false,
        error: "No files selected. Please select one or more files in Google Drive, then open the assistant."
      };
    }

    const fileIds = JSON.parse(storedSelection);
    const fileData = [];

    for (const id of fileIds) {
      const file = DriveApp.getFileById(id);
      const mimeType = file.getMimeType();
      const fileName = file.getName();
      let content = "";

      Logger.log("Processing: " + fileName + " (" + mimeType + ")");

      if (mimeType === "application/pdf") {
        // PDF Logic with OCR fallback
        try {
          const extractedText = await extractPdfTextSmart(id);
          content = formatExtractedText(extractedText);
        } catch (e) {
          Logger.log("PDF extraction failed: " + e);
          content = "[Error extracting PDF text]";
        }
      } else if (mimeType === "text/plain" || fileName.endsWith(".txt") || mimeType.includes("text/")) {
        // Plain Text Logic
        try {
          const textBlob = file.getBlob().getDataAsString();
          content = formatExtractedText(textBlob);
          Logger.log("Plain text extracted successfully.");
        } catch (e) {
          Logger.log("Text extraction failed: " + e);
          content = "[Error reading text file]";
        }
      } else if (mimeType.includes("google-apps.document")) {
        // Google Doc Logic
        try {
          content = formatExtractedText(DocumentApp.openById(id).getBody().getText());
        } catch (e) {
          content = "[Error reading Google Doc]";
        }
      }

      fileData.push({
        fileId: id,
        currentName: fileName,
        mimeType: mimeType,
        content: content
      });
    }

    return { success: true, files: fileData };
  } catch (err) {
    Logger.log("Error in getSelectedFiles: " + err);
    return { success: false, error: "An internal error occurred: " + err.message };
  }
}

/**
 * Helper to clean and truncate text for the Gemini prompt.
 */
function formatExtractedText(text) {
  if (typeof text !== "string" || text.trim().length === 0) return "[No text extracted]";

  // Clean whitespace and truncate
  let cleaned = text.replace(/\s+/g, ' ').trim().substring(0, 2000);
  if (text.length > 2000) cleaned += "... [truncated]";
  return cleaned;
}

/**
 * Renames a file in Drive.
 */
function renameFile(fileId, newName) {
  try {
    const file = DriveApp.getFileById(fileId);
    const oldName = file.getName();
    file.setName(newName);
    console.log('Renamed ' + oldName + ' to ' + newName);
    return { success: true, fileId: fileId, newName: newName };
  } catch (e) {
    console.error('Rename failed for ID: ' + fileId, e);
    return { success: false, error: e.toString() };
  }
}

function renameFile() {
  let id = null;
  let originalName = null;
  let proposedName = null;
  let folderId = null;

  // 1. Parse arguments across single objects and positional parameters
  if (arguments.length > 0 && typeof arguments[0] === 'object' && arguments[0] !== null) {
    const data = arguments[0];
    id = data.id || data.fileId || null;
    originalName = data.originalName || data.originalFilename || data.name || data.filename || data.title || null;
    proposedName = data.proposedName || data.newName || data.newFileName || data.proposedFilename || data.suggestedName || data.targetName || null;
    folderId = data.folderId || null;
  } else if (arguments.length === 2) {
    const arg1 = String(arguments[0] || '').trim();
    const arg2 = String(arguments[1] || '').trim();

    if (arg1.startsWith('id-')) {
      id = arg1;
      proposedName = arg2;
      originalName = null;
    } else {
      id = arg1;
      originalName = arg1;
      proposedName = arg2;
    }
  } else if (arguments.length >= 3) {
    id = arguments[0];
    originalName = arguments[1];
    proposedName = arguments[2];
    folderId = arguments[3] || null;
  }

  // Clean inputs
  if (id) id = String(id).trim();
  if (originalName) originalName = String(originalName).trim();
  if (proposedName) proposedName = String(proposedName).trim();

  if (originalName && originalName.startsWith('id-')) {
    originalName = null;
  }

  if (!proposedName) {
    throw new Error("Missing proposed new file name.");
  }

  let file = null;

  // Helper function to query Drive with exact and trailing-space name variations
  function findFileByName(nameStr) {
    if (!nameStr) return null;

    let search = folderId ? DriveApp.getFolderById(folderId).getFilesByName(nameStr) : DriveApp.getFilesByName(nameStr);
    if (search.hasNext()) return search.next();

    // Toggle space before .pdf extension (e.g., "Release.pdf" vs "Release .pdf")
    let altName = nameStr;
    if (/\.pdf$/i.test(nameStr) && !/\s+\.pdf$/i.test(nameStr)) {
      altName = nameStr.replace(/\.pdf$/i, ' .pdf');
    } else if (/\s+\.pdf$/i.test(nameStr)) {
      altName = nameStr.replace(/\s+\.pdf$/i, '.pdf');
    }

    if (altName !== nameStr) {
      search = folderId ? DriveApp.getFolderById(folderId).getFilesByName(altName) : DriveApp.getFilesByName(altName);
      if (search.hasNext()) return search.next();
    }

    return null;
  }

  // Step 1: Real Drive ID lookup
  if (id && !id.startsWith('id-')) {
    try {
      file = DriveApp.getFileById(id);
    } catch (e) {
      console.warn("Invalid Drive ID, falling back to name search:", id);
    }
  }

  // Step 2: Search by explicit originalName
  if (!file && originalName) {
    file = findFileByName(originalName);
  }

  // Step 3: Infer original filename by specifically stripping prefix patterns like "EF-01 "
  if (!file && proposedName) {
    const strippedName = proposedName
      .replace(/^[A-Za-z]{1,5}[-_\s]?\d{1,3}\s*[\-_.]?\s*/, '') // Strips "EF-01 " without stripping words like "Employee "
      .trim();

    if (strippedName && strippedName !== proposedName) {
      file = findFileByName(strippedName);
    }
  }

  // Step 4: Fallback Drive search using partial keywords
  if (!file && proposedName) {
    const cleanKeywords = proposedName
      .replace(/^[A-Za-z]{1,5}[-_\s]?\d{1,3}\s*[\-_.]?\s*/, '')
      .replace(/\.pdf$/i, '')
      .replace(/[^a-zA-Z0-9\s]/g, ' ')
      .trim();

    const words = cleanKeywords.split(/\s+/).filter(w => w.length > 3);
    if (words.length > 0) {
      const query = words.slice(0, 3).map(w => `title contains '${w.replace(/'/g, "\\'")}'`).join(' and ') + " and trashed = false";
      try {
        const search = DriveApp.searchFiles(query);
        if (search.hasNext()) {
          file = search.next();
        }
      } catch (e) {
        console.warn("Drive search query failed:", e);
      }
    }
  }

  if (file.getName() === proposedName) {
    return `File is already named "${proposedName}"`;
  }

  const oldName = file.getName();
  file.setName(proposedName);
  return `Successfully renamed "${oldName}" to "${proposedName}"`;
}


/**
 * Extracts text from a PDF, trying PdfApp library first then OCR.
 * Accepts a Drive file ID, a file object, or a filename as fallback.
 */
function extractPdfTextSmart(fileIdentifier, minTextLength, folderId) {
  let file = null;

  // 1. Try fetching by ID (if it's a valid Drive ID string)
  if (typeof fileIdentifier === 'string' && !fileIdentifier.startsWith('id-')) {
    try {
      file = DriveApp.getFileById(fileIdentifier);
    } catch (e) {
      Logger.log("Invalid ID for extraction, falling back to name search: " + fileIdentifier);
    }
  } else if (typeof fileIdentifier === 'object' && fileIdentifier !== null && typeof fileIdentifier.getBlob === 'function') {
    file = fileIdentifier;
  }

  // 2. Fallback: Search by name within specified folder
  if (!file && folderId && typeof fileIdentifier === 'string') {
    try {
      const folder = DriveApp.getFolderById(folderId);
      const files = folder.getFilesByName(fileIdentifier);
      if (files.hasNext()) {
        file = files.next();
      }
    } catch (e) {
      Logger.log("Folder search error during extraction: " + e);
    }
  }

  // 3. Fallback: Search by name globally in Drive
  if (!file && typeof fileIdentifier === 'string') {
    const files = DriveApp.getFilesByName(fileIdentifier);
    if (files.hasNext()) {
      file = files.next();
    }
  }

  if (!file) {
    Logger.log("Could not locate file for text extraction: " + fileIdentifier);
    return "[No content available for this file]";
  }

  // Extract content from resolved file blob
  const blob = file.getBlob();
  const threshold = Math.max(0, Number(minTextLength) || 50);

  try {
    if (typeof PdfApp !== "undefined" && typeof PdfApp.extractText === "function") {
      const result = PdfApp.extractText(blob); // Removed 'await'
      if (typeof result === "string" && result.trim().length > threshold) {
        return result.trim();
      }
    }
  } catch (err) {
    Logger.log("PdfApp failed for " + file.getName() + ": " + err);
  }

  Logger.log("Falling back to OCR for " + file.getName());
  return extractWithOCR(blob);
}



/**
 * OCR extraction via temp Google Doc.
 */
function extractWithOCR(blob) {
  let tempFileId = null;
  try {
    const resource = {
      name: "temp_ocr_" + Date.now(),
      mimeType: "application/vnd.google-apps.document"
    };
    const file = Drive.Files.create(resource, blob);
    tempFileId = file.id;
    const doc = DocumentApp.openById(tempFileId);
    return doc.getBody().getText() || "";
  } catch (e) {
    Logger.log("OCR failed: " + e);
    return "";
  } finally {
    if (tempFileId) {
      try { DriveApp.getFileById(tempFileId).setTrashed(true); } catch (e) { }
    }
  }
}

function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('dist/index')
    .setTitle('DriveRename AI')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}


/**
 * Renames multiple files directly without calling Gemini.
 * @param {Array<{id: string, originalName: string, proposedName: string, folderId: string}>} requests
 */
function batchRenameFiles(requests) {
  if (!Array.isArray(requests) || requests.length === 0) {
    return { success: false, message: "No rename requests provided." };
  }

  const results = [];

  for (let i = 0; i < requests.length; i++) {
    try {
      const result = renameFile(requests[i]);
      results.push({ index: i, success: true, message: result });
    } catch (err) {
      results.push({ index: i, success: false, message: err.message });
    }
  }

  return { success: true, results: results };
}


