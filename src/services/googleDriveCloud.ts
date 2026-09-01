import { DriveFile, BatchRenameItem, BatchRenameResponse } from '../lib/drive-service';

declare global {
  interface Window {
    gapi?: any;
    google?: any;
  }
}

/**
 * Ensures the Google Picker API script is loaded via gapi.load
 */
export const loadGooglePickerApi = (): Promise<void> => {
  return new Promise((resolve, reject) => {
    if (window.google?.picker) {
      resolve();
      return;
    }
    if (!window.gapi) {
      reject(new Error('Google API client (gapi) is not available in the window.'));
      return;
    }
    window.gapi.load('picker', {
      callback: () => {
        if (window.google?.picker) {
          resolve();
        } else {
          reject(new Error('Google Picker failed to initialize.'));
        }
      },
      onerror: () => {
        reject(new Error('Failed to load Google Picker library.'));
      },
    });
  });
};

export interface PickedFileMetadata {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes?: number;
  lastEditedUtc?: string;
  url?: string;
  iconUrl?: string;
}

/**
 * Opens Google Picker modal for selecting files from Google Drive.
 */
export const openGoogleDrivePicker = async (options: {
  accessToken: string;
  onFilesPicked: (files: PickedFileMetadata[]) => void;
  onCancel?: () => void;
}): Promise<void> => {
  await loadGooglePickerApi();

  const { accessToken, onFilesPicked, onCancel } = options;

  const pickerOrigin =
    window.location.ancestorOrigins && window.location.ancestorOrigins.length > 0
      ? window.location.ancestorOrigins[window.location.ancestorOrigins.length - 1]
      : window.location.origin;

  const view = new window.google.picker.DocsView(window.google.picker.ViewId.DOCS)
    .setIncludeFolders(true)
    .setSelectFolderEnabled(false)
    .setMode(window.google.picker.DocsViewMode.LIST);

  const picker = new window.google.picker.PickerBuilder()
    .addView(view)
    .setOAuthToken(accessToken)
    .setOrigin(pickerOrigin)
    .enableFeature(window.google.picker.Feature.MULTISELECT_ENABLED)
    .enableFeature(window.google.picker.Feature.SUPPORT_DRIVES)
    .setTitle('Select Google Drive Files to Rename')
    .setCallback(async (data: any) => {
      if (data.action === window.google.picker.Action.PICKED) {
        const rawDocs = data.docs || [];
        const files: PickedFileMetadata[] = rawDocs.map((doc: any) => ({
          id: doc.id,
          name: doc.name,
          mimeType: doc.mimeType || 'application/octet-stream',
          sizeBytes: doc.sizeBytes ? Number(doc.sizeBytes) : undefined,
          lastEditedUtc: doc.lastEditedUtc,
          url: doc.url,
          iconUrl: doc.iconUrl,
        }));
        onFilesPicked(files);
      } else if (data.action === window.google.picker.Action.CANCEL) {
        if (onCancel) onCancel();
      }
    })
    .build();

  picker.setVisible(true);
};

/**
 * Direct REST API call to fetch file text preview from Drive if feasible.
 */
export const fetchCloudFileDetails = async (
  fileId: string,
  accessToken: string
): Promise<DriveFile> => {
  const metaRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,size,modifiedTime,description`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!metaRes.ok) {
    const errText = await metaRes.text();
    throw new Error(`Failed to get file info (${metaRes.status}): ${errText}`);
  }

  const meta = await metaRes.json();
  let contentSnippet = '';

  // Attempt to fetch content for plain text or exportable docs
  try {
    if (meta.mimeType.startsWith('text/') || meta.mimeType === 'application/json') {
      const mediaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (mediaRes.ok) {
        const text = await mediaRes.text();
        contentSnippet = text.slice(0, 1500);
      }
    } else if (meta.mimeType === 'application/vnd.google-apps.document') {
      const exportRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );
      if (exportRes.ok) {
        const text = await exportRes.text();
        contentSnippet = text.slice(0, 1500);
      }
    }
  } catch (e) {
    console.warn('Could not extract preview text for file', fileId, e);
  }

  return {
    fileId: meta.id,
    currentName: meta.name,
    mimeType: meta.mimeType,
    content: contentSnippet || undefined,
    source: 'picker',
  };
};

/**
 * Direct REST API call to rename a single file in Google Drive.
 */
export const cloudRenameFile = async (
  fileId: string,
  newName: string,
  accessToken: string
): Promise<{ success: boolean; newName: string; error?: string }> => {
  try {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: newName }),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({ error: { message: res.statusText } }));
      throw new Error(errData?.error?.message || `HTTP ${res.status}`);
    }

    const data = await res.json();
    return { success: true, newName: data.name };
  } catch (error: any) {
    return { success: false, newName, error: error.message || 'Unknown renaming error' };
  }
};

/**
 * Direct REST API call to batch rename multiple files in Google Drive.
 */
export const cloudBatchRenameFiles = async (
  requests: BatchRenameItem[],
  accessToken: string
): Promise<BatchRenameResponse> => {
  const results: BatchRenameResponse['results'] = [];
  let totalSuccess = 0;
  let totalFailed = 0;

  for (const item of requests) {
    const renameRes = await cloudRenameFile(item.id, item.proposedName, accessToken);
    if (renameRes.success) {
      totalSuccess++;
      results.push({
        id: item.id,
        originalName: item.originalName,
        newName: item.proposedName,
        success: true,
      });
    } else {
      totalFailed++;
      results.push({
        id: item.id,
        originalName: item.originalName,
        newName: item.proposedName,
        success: false,
        error: renameRes.error,
      });
    }
  }

  return {
    success: totalFailed === 0,
    totalRequested: requests.length,
    totalSuccess,
    totalFailed,
    results,
  };
};
