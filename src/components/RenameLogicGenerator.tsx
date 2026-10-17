import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import {
  Loader2,
  Play,
  Copy,
  Check,
  RefreshCw,
  Sparkles,
  Wand2,
  SlidersHorizontal,
  ArrowRight,
  FileText,
  Trash2,
  Edit3,
  Calendar,
  Hash,
  Replace,
  CheckCircle2,
  XCircle,
  Cloud,
  Laptop,
  FolderOpen,
  LogOut,
  ShieldCheck,
  Globe,
  Info,
  Key,
} from "lucide-react";
import { getRenameSuggestions, FileSuggestion, initGemini, isGeminiConfigured, getActiveGeminiModel } from "@/src/services/geminiService";
import {
  AppsScriptResponse,
  DriveFile,
  BatchRenameItem,
  BatchRenameResponse,
} from "@/src/lib/drive-service";
import {
  initAuth,
  googleSignIn,
  googleSignOut,
  getCachedAccessToken,
} from "@/src/services/googleDriveAuth";
import {
  openGoogleDrivePicker,
  cloudBatchRenameFiles,
  fetchCloudFileDetails,
} from "@/src/services/googleDriveCloud";
import type { User } from "firebase/auth";

interface EditableSuggestion extends FileSuggestion {
  status?: "pending" | "success" | "error";
  errorMessage?: string;
}

export default function RenameLogicGenerator() {
  // Check if running inside Google Apps Script host container
  const isAppsScriptEnvironment = useMemo(() => {
    if (typeof window === "undefined") return false;
    // @ts-ignore
    const hasGoogleScript = typeof google !== "undefined" && !!google.script && !!google.script.run;
    const isGoogleHost = window.location.hostname.includes("googleusercontent.com") ||
                         window.location.hostname.includes("script.google.com");
    return hasGoogleScript || isGoogleHost;
  }, []);

  // Hybrid routing mode: 'local' (Apps Script) vs 'cloud' (Direct Google Drive API)
  // When running inside Google Apps Script or on Google's iframe host, default to 'local'
  // so native DriveApp permissions are used with zero Firebase Auth requirements!
  const [executionMode, setExecutionMode] = useState<"local" | "cloud">(() => {
    if (typeof window !== "undefined") {
      // @ts-ignore
      const hasGoogleScript = typeof google !== "undefined" && !!google.script && !!google.script.run;
      const isGoogleHost = window.location.hostname.includes("googleusercontent.com") ||
                           window.location.hostname.includes("script.google.com");
      if (hasGoogleScript || isGoogleHost) {
        return "local";
      }
    }
    return "cloud";
  });
  const [activeWorkflow, setActiveWorkflow] = useState<"ai" | "rules">("ai");

  // Google OAuth User State
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [pickingFiles, setPickingFiles] = useState(false);

  // Files & Renaming state
  const [fileInput, setFileInput] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<DriveFile[]>([]);
  const [intent, setIntent] = useState("Organize by date and project name");
  const [suggestions, setSuggestions] = useState<EditableSuggestion[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [copied, setCopied] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [tempEditedName, setTempEditedName] = useState("");

  // Gemini API Key state & management
  const [isKeyReady, setIsKeyReady] = useState<boolean>(() => isGeminiConfigured());
  const [showKeyConfig, setShowKeyConfig] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [savingKey, setSavingKey] = useState(false);

  // Rule-based batch renaming state
  const [prefix, setPrefix] = useState("");
  const [suffix, setSuffix] = useState("");
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [caseTransform, setCaseTransform] = useState<"none" | "lower" | "upper" | "title" | "kebab" | "snake">("none");
  const [includeDateStamp, setIncludeDateStamp] = useState(false);
  const [dateStampPosition, setDateStampPosition] = useState<"prefix" | "suffix">("prefix");
  const [dateStampFormat, setDateStampFormat] = useState<"YYYYMMDD_" | "YYYY-MM-DD_" | "YYYYMMDD">("YYYYMMDD_");
  const [addSequence, setAddSequence] = useState(false);
  const [sequenceStart, setSequenceStart] = useState(1);
  const [sequencePadding, setSequencePadding] = useState(2);

  // Local Apps Script: Fetch Selected Files via native google.script.run
  const fetchFilesFromAppsScript = useCallback((isAutoFetch = false) => {
    setFetching(true);
    try {
      // @ts-ignore
      if (typeof google !== "undefined" && google.script && google.script.run) {
        // @ts-ignore
        google.script.run
          .withSuccessHandler((response: AppsScriptResponse) => {
            setFetching(false);
            if (response && response.success && response.files && response.files.length > 0) {
              setSelectedFiles(
                response.files.map((f) => ({ ...f, source: "apps-script" }))
              );
              toast.success(`Loaded ${response.files.length} selected files from Google Drive`);
            } else if (!isAutoFetch) {
              if (response && response.error) {
                toast.info(response.error);
              } else {
                toast.info("No files selected in Google Drive. Select files in Drive and click fetch.");
              }
            }
          })
          .withFailureHandler((err: Error) => {
            setFetching(false);
            if (!isAutoFetch) {
              console.error("Script Execution Error (getSelectedFiles):", err);
              toast.error("Apps Script Error: " + err.message);
            }
          })
          .getSelectedFiles();
      } else {
        setFetching(false);
        if (!isAutoFetch) {
          toast.info("Apps Script host not detected in standalone view. You can switch to Cloud mode or enter names manually.");
        }
      }
    } catch (error) {
      setFetching(false);
      console.error("Fetch error:", error);
    }
  }, []);

  // Save Gemini Key to Google Apps Script Properties and localStorage
  const handleSaveGeminiKey = (newKey: string) => {
    const trimmed = newKey.trim();
    if (!trimmed) {
      toast.error("Please enter a valid Gemini API key");
      return;
    }
    setSavingKey(true);
    initGemini(trimmed);
    if (typeof window !== "undefined") {
      localStorage.setItem("GEMINI_API_KEY", trimmed);
    }
    // @ts-ignore
    if (typeof google !== "undefined" && google.script && google.script.run) {
      // @ts-ignore
      google.script.run
        .withSuccessHandler(() => {
          setSavingKey(false);
          setIsKeyReady(true);
          setShowKeyConfig(false);
          setKeyInput("");
          toast.success("Gemini API key saved to Workspace Script Properties!");
        })
        .withFailureHandler((err: Error) => {
          console.warn("Could not save to Script Properties:", err);
          setSavingKey(false);
          setIsKeyReady(true);
          setShowKeyConfig(false);
          setKeyInput("");
          toast.success("Gemini API key saved locally for this session!");
        })
        .setGeminiApiKey(trimmed);
    } else {
      setSavingKey(false);
      setIsKeyReady(true);
      setShowKeyConfig(false);
      setKeyInput("");
      toast.success("Gemini API key saved locally!");
    }
  };

  // Initialize Auth & Apps Script integration on mount
  useEffect(() => {
    const unsubscribe = initAuth(
      (user, token) => {
        setCurrentUser(user);
        setAccessToken(token);
      },
      () => {
        setCurrentUser(null);
        setAccessToken(null);
      }
    );

    // If running in Apps Script host container
    if (isAppsScriptEnvironment) {
      setExecutionMode("local");
      // Auto-load selected files from Drive
      fetchFilesFromAppsScript(true);

      // Attempt to retrieve Gemini API key from Apps Script Properties
      // @ts-ignore
      if (typeof google !== "undefined" && google.script && google.script.run) {
        // @ts-ignore
        google.script.run
          .withSuccessHandler((key: string) => {
            if (key) {
              initGemini(key);
              setIsKeyReady(true);
              console.log("Gemini initialized with Apps Script key");
            } else {
              setIsKeyReady(isGeminiConfigured());
            }
          })
          .withFailureHandler((err: Error) => {
            console.warn("Script Execution Note (getGeminiApiKey):", err);
            setIsKeyReady(isGeminiConfigured());
          })
          .getGeminiApiKey();
      }
    } else {
      setIsKeyReady(isGeminiConfigured());
    }

    return () => {
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, [isAppsScriptEnvironment, fetchFilesFromAppsScript]);

  // Google Sign In handler
  const handleGoogleSignIn = async () => {
    setAuthLoading(true);
    try {
      const res = await googleSignIn();
      if (res) {
        setCurrentUser(res.user);
        setAccessToken(res.accessToken);
        toast.success(`Connected as ${res.user.email || res.user.displayName || "Google User"}`);
      }
    } catch (err: any) {
      console.error("Sign in failed:", err);
      if (err?.code === "auth/unauthorized-domain" || err?.message?.includes("unauthorized-domain")) {
        const domain = err.domain || (typeof window !== "undefined" ? window.location.hostname : "this domain");
        toast.error(`Unauthorized Domain: ${domain}`, {
          description: `Add "${domain}" in Firebase Console > Authentication > Settings > Authorized domains.`,
          duration: 12000,
        });
      } else {
        toast.error(err.message || "Failed to sign in with Google.");
      }
    } finally {
      setAuthLoading(false);
    }
  };

  // Google Sign Out handler
  const handleGoogleSignOut = async () => {
    try {
      await googleSignOut();
      setCurrentUser(null);
      setAccessToken(null);
      toast.info("Signed out from Google Drive session.");
    } catch (err: any) {
      console.error("Sign out failed:", err);
    }
  };

  // Google Picker Handler (Cloud Mode)
  const handleOpenPicker = async () => {
    const token = accessToken || getCachedAccessToken();
    if (!token) {
      toast.error("Please sign in with Google to access the Drive File Picker.");
      return;
    }

    setPickingFiles(true);
    try {
      await openGoogleDrivePicker({
        accessToken: token,
        onFilesPicked: async (pickedList) => {
          setPickingFiles(false);
          if (pickedList.length === 0) return;

          toast.loading(`Loading metadata for ${pickedList.length} files...`, { id: "picker-load" });

          // Fetch metadata and snippets if available
          const loadedFiles: DriveFile[] = [];
          for (const item of pickedList) {
            try {
              const details = await fetchCloudFileDetails(item.id, token);
              loadedFiles.push({
                fileId: details.fileId,
                currentName: details.currentName,
                mimeType: details.mimeType,
                content: details.content,
                sizeBytes: item.sizeBytes,
                iconUrl: item.iconUrl,
                source: "picker",
              });
            } catch (e) {
              loadedFiles.push({
                fileId: item.id,
                currentName: item.name,
                mimeType: item.mimeType,
                sizeBytes: item.sizeBytes,
                iconUrl: item.iconUrl,
                source: "picker",
              });
            }
          }

          setSelectedFiles(loadedFiles);
          toast.dismiss("picker-load");
          toast.success(`Added ${loadedFiles.length} files from Google Drive`);
        },
        onCancel: () => {
          setPickingFiles(false);
        },
      });
    } catch (err: any) {
      setPickingFiles(false);
      console.error("Google Picker Error:", err);
      toast.error(err.message || "Failed to open Google Picker dialog.");
    }
  };

  // Helper to separate filename and extension
  const splitFileName = (fullName: string) => {
    const lastDot = fullName.lastIndexOf(".");
    if (lastDot <= 0) {
      return { base: fullName, ext: "" };
    }
    return {
      base: fullName.slice(0, lastDot),
      ext: fullName.slice(lastDot),
    };
  };

  // Helper to format today's date
  const getFormattedDate = (format: string) => {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");

    if (format === "YYYYMMDD_") return `${yyyy}${mm}${dd}_`;
    if (format === "YYYY-MM-DD_") return `${yyyy}-${mm}-${dd}_`;
    if (format === "YYYYMMDD") return `${yyyy}${mm}${dd}`;
    return `${yyyy}${mm}${dd}_`;
  };

  // Apply string casing
  const applyCaseTransform = (str: string, type: typeof caseTransform) => {
    if (type === "lower") return str.toLowerCase();
    if (type === "upper") return str.toUpperCase();
    if (type === "title") {
      return str.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    }
    if (type === "kebab") {
      return str
        .replace(/([a-z])([A-Z])/g, "$1-$2")
        .replace(/[\s_]+/g, "-")
        .toLowerCase();
    }
    if (type === "snake") {
      return str
        .replace(/([a-z])([A-Z])/g, "$1_$2")
        .replace(/[\s-]+/g, "_")
        .toLowerCase();
    }
    return str;
  };

  // Compute a single file transformation based on rules
  const transformFileName = (originalName: string, index: number): string => {
    const { base, ext } = splitFileName(originalName);
    let newBase = base;

    // 1. Find and replace
    if (findText) {
      newBase = newBase.replaceAll(findText, replaceText);
    }

    // 2. Case transformation
    if (caseTransform !== "none") {
      newBase = applyCaseTransform(newBase, caseTransform);
    }

    // 3. Format sequence number string
    let formattedNum = "";
    if (addSequence) {
      const num = sequenceStart + index;
      formattedNum = String(num).padStart(sequencePadding, "0");
    }

    // 4. Prefix & Date stamp prefix
    // If prefix is added with sequence (and no suffix), sequence attaches to the end of prefix: prefix00-filename or prefix00_filename
    let appliedPrefix = prefix;
    if (includeDateStamp && dateStampPosition === "prefix") {
      appliedPrefix = getFormattedDate(dateStampFormat) + appliedPrefix;
    }

    // 5. Suffix & Date stamp suffix
    // If suffix is added with sequence, sequence attaches to the end of suffix: filenamesufix00
    let appliedSuffix = suffix;
    if (includeDateStamp && dateStampPosition === "suffix") {
      appliedSuffix = appliedSuffix + "_" + getFormattedDate(dateStampFormat).replace(/_$/, "");
    }

    // Determine sequence placement:
    // If user has prefix and no suffix: attach sequence to the end of prefix (e.g. prefix00 + filename)
    // If user has suffix: attach sequence to the end of suffix (e.g. filename + sufix00)
    // If neither prefix nor suffix: append to end of base name (e.g. filename_00)
    // If both prefix and suffix: attach sequence to suffix at the end
    if (addSequence && formattedNum) {
      if (appliedPrefix && !appliedSuffix) {
        appliedPrefix = `${appliedPrefix}${formattedNum}`;
      } else if (appliedSuffix) {
        appliedSuffix = `${appliedSuffix}${formattedNum}`;
      } else {
        newBase = `${newBase}_${formattedNum}`;
      }
    }

    if (appliedPrefix) {
      newBase = appliedPrefix + newBase;
    }
    if (appliedSuffix) {
      newBase = newBase + appliedSuffix;
    }

    return newBase + ext;
  };

  // Get active source files list
  const currentWorkingFiles = useMemo(() => {
    if (selectedFiles.length > 0) {
      return selectedFiles.map((f) => ({
        id: f.fileId,
        name: f.currentName,
        content: f.content,
        mimeType: f.mimeType,
      }));
    }
    if (fileInput.trim()) {
      const lines = fileInput.split(/\n|,/).filter((l) => l.trim());
      return lines.map((line, idx) => {
        const parts = line.split("|");
        return {
          id: parts[1]?.trim() || `id-${idx}`,
          name: parts[0]?.trim() || line.trim(),
          content: undefined,
          mimeType: "unknown",
        };
      });
    }
    return [];
  }, [selectedFiles, fileInput]);

  // Live preview of rule transformation
  const rulePreviewSamples = useMemo(() => {
    if (currentWorkingFiles.length === 0) return [];
    return currentWorkingFiles.slice(0, 3).map((f, i) => ({
      original: f.name,
      proposed: transformFileName(f.name, i),
    }));
  }, [currentWorkingFiles, prefix, suffix, findText, replaceText, caseTransform, includeDateStamp, dateStampPosition, dateStampFormat, addSequence, sequenceStart, sequencePadding]);

  // Generate Suggestions from Rules
  const handleApplyRules = () => {
    if (currentWorkingFiles.length === 0) {
      toast.error("Please provide files first via Drive selection, Picker, or manual input.");
      return;
    }

    const ruleDescriptions: string[] = [];
    if (prefix) ruleDescriptions.push(`Prefix: "${prefix}"`);
    if (suffix) ruleDescriptions.push(`Suffix: "${suffix}"`);
    if (findText) ruleDescriptions.push(`Replace "${findText}" → "${replaceText}"`);
    if (caseTransform !== "none") ruleDescriptions.push(`Case: ${caseTransform}`);
    if (includeDateStamp) ruleDescriptions.push(`Date (${dateStampPosition})`);
    if (addSequence) ruleDescriptions.push(`Sequence (+${sequenceStart})`);

    const summaryReason = ruleDescriptions.length > 0
      ? `Batch Rule (${ruleDescriptions.join(", ")})`
      : "Direct Batch Rule Transformation";

    const generated: EditableSuggestion[] = currentWorkingFiles.map((file, idx) => ({
      id: file.id,
      originalName: file.name,
      proposedName: transformFileName(file.name, idx),
      reasoning: summaryReason,
      status: "pending",
    }));

    setSuggestions(generated);
    setSelectedIds(new Set(generated.map((g) => g.id)));
    toast.success(`Generated ${generated.length} batch rule proposals.`);
  };

  // Execution Router: handles both Cloud (Drive REST API) and Local (Apps Script)
  const handleExecuteRenaming = async () => {
    const selectedSuggestions = suggestions.filter((s) => selectedIds.has(s.id));
    if (selectedSuggestions.length === 0) {
      toast.error("No items selected for renaming.");
      return;
    }

    const batchRequests: BatchRenameItem[] = selectedSuggestions.map((item) => ({
      id: item.id,
      fileId: item.id,
      originalName: item.originalName,
      proposedName: item.proposedName,
    }));

    // ==========================================
    // CLOUD MODE: Direct Google Drive v3 REST API
    // ==========================================
    if (executionMode === "cloud") {
      const token = accessToken || getCachedAccessToken();
      if (!token) {
        toast.error("Please sign in with Google to perform direct Cloud renames.");
        return;
      }

      setRenaming(true);
      toast.loading(`Executing Cloud batch rename for ${batchRequests.length} files...`, { id: "cloud-rename" });

      try {
        const response = await cloudBatchRenameFiles(batchRequests, token);
        setRenaming(false);
        toast.dismiss("cloud-rename");

        const updated = suggestions.map((item) => {
          if (!selectedIds.has(item.id)) return item;
          const resItem = response.results?.find((r) => r.id === item.id);
          if (resItem) {
            if (resItem.success) {
              return { ...item, status: "success" as const };
            } else {
              return { ...item, status: "error" as const, errorMessage: resItem.error || resItem.message };
            }
          }
          return item;
        });

        setSuggestions(updated);

        if (response.totalFailed === 0) {
          toast.success(`Cloud Rename Succeeded! All ${response.totalSuccess} files renamed in Google Drive.`);
        } else {
          toast.warning(`Renamed ${response.totalSuccess} files. ${response.totalFailed} encountered errors.`);
        }
      } catch (err: any) {
        setRenaming(false);
        toast.dismiss("cloud-rename");
        console.error("Cloud Rename Error:", err);
        toast.error(`Cloud Rename Failed: ${err.message}`);
      }
      return;
    }

    // ==========================================
    // LOCAL MODE: Google Apps Script (code.gs)
    // ==========================================
    // @ts-ignore
    if (typeof google === "undefined" || !google.script || !google.script.run) {
      toast.info("Local Apps Script host not detected in this window. Simulating execution.");
      setRenaming(true);
      setTimeout(() => {
        setSuggestions((prev) =>
          prev.map((item) =>
            selectedIds.has(item.id) ? { ...item, status: "success" } : item
          )
        );
        setRenaming(false);
        toast.success(`Simulation: Renamed ${selectedSuggestions.length} files successfully.`);
      }, 700);
      return;
    }

    setRenaming(true);
    try {
      // @ts-ignore
      google.script.run
        .withSuccessHandler((response: BatchRenameResponse) => {
          setRenaming(false);
          if (response && response.success) {
            let successCount = 0;
            let failCount = 0;

            const updated = suggestions.map((item) => {
              if (!selectedIds.has(item.id)) return item;
              const reqIdx = batchRequests.findIndex((r) => r.id === item.id);
              const resItem = response.results?.find((r) => r.index === reqIdx);

              if (resItem) {
                if (resItem.success) {
                  successCount++;
                  return { ...item, status: "success" as const };
                } else {
                  failCount++;
                  return { ...item, status: "error" as const, errorMessage: resItem.message };
                }
              }
              successCount++;
              return { ...item, status: "success" as const };
            });

            setSuggestions(updated);

            if (failCount === 0) {
              toast.success(`Apps Script batch rename completed! ${successCount} files renamed.`);
            } else {
              toast.warning(`Renamed ${successCount} files. ${failCount} encountered errors.`);
            }
          } else {
            console.error("Apps Script Batch rename failed:", response?.message);
            toast.error(response?.message || "Batch rename encountered an error.");
          }
        })
        .withFailureHandler((err: Error) => {
          setRenaming(false);
          console.error("Script Execution Crashed (batchRenameFiles):", err);
          toast.error("Apps Script Error: " + err.message);
        })
        .batchRenameFiles(batchRequests);
    } catch (err: any) {
      setRenaming(false);
      console.error("Failed to trigger batchRenameFiles:", err);
      toast.error("Failed to execute batch rename: " + err.message);
    }
  };

  const handleAnalyze = async () => {
    if (selectedFiles.length === 0 && !fileInput.trim()) {
      toast.error("Please provide file names or select files from Google Drive.");
      return;
    }

    if (!isKeyReady && !isGeminiConfigured()) {
      setShowKeyConfig(true);
      toast.error("Gemini API key required for AI renaming.", {
        description: "Please enter your Gemini API key below or set GEMINI_API_KEY in Apps Script Script Properties."
      });
      return;
    }

    setLoading(true);
    try {
      let files: { id: string; name: string; content?: string }[] = [];

      if (selectedFiles.length > 0) {
        files = selectedFiles.map((f) => ({
          id: f.fileId,
          name: f.currentName,
          content: f.content,
        }));
      } else {
        const lines = fileInput.split(/\n|,/).filter((l) => l.trim());
        files = lines.map((line, index) => {
          const parts = line.split("|");
          return {
            id: parts[1]?.trim() || `id-${index}`,
            name: parts[0]?.trim() || line.trim(),
          };
        });
      }

      const result = await getRenameSuggestions(files, intent);
      const mappedResults: EditableSuggestion[] = result.map((r) => ({
        ...r,
        status: "pending",
      }));

      setSuggestions(mappedResults);
      setSelectedIds(new Set(result.map((s) => s.id)));

      if (result.length > 0) {
        toast.success(`Generated ${result.length} AI proposals using Gemini!`);
      } else {
        toast.warning("Gemini returned no suggestions. Try adjusting your intent.");
      }
    } catch (error: any) {
      console.error("Analyze error details:", error);
      const errorMessage = error?.message || String(error);
      if (
        errorMessage.includes("GEMINI_API_KEY_MISSING") ||
        errorMessage.includes("API key not valid") ||
        errorMessage.includes("API_KEY_INVALID")
      ) {
        setShowKeyConfig(true);
        toast.error("Missing or invalid Gemini API Key. Enter your key in the AI settings panel.");
      } else if (errorMessage.includes("quota") || errorMessage.includes("429")) {
        toast.error("Gemini API quota exceeded. Please try again in a moment.");
      } else {
        toast.error("Failed to generate suggestions. " + (errorMessage.length > 90 ? errorMessage.slice(0, 90) + "..." : errorMessage));
      }
    } finally {
      setLoading(false);
    }
  };

  const removeFile = (id: string) => {
    setSelectedFiles((prev) => prev.filter((f) => f.fileId !== id));
  };

  const toggleSelect = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const toggleAll = () => {
    if (selectedIds.size === suggestions.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(suggestions.map((s) => s.id)));
    }
  };

  const startEditing = (id: string, currentProposed: string) => {
    setEditingId(id);
    setTempEditedName(currentProposed);
  };

  const saveEditing = (id: string) => {
    if (tempEditedName.trim()) {
      setSuggestions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, proposedName: tempEditedName.trim() } : s))
      );
    }
    setEditingId(null);
  };

  const generateAppsScript = () => {
    return `/**
 * Google Apps Script Add-on logic for batch renaming files.
 * Includes direct batch processing and Card UI execution.
 * Generated by DriveRename AI.
 */

/**
 * Renames multiple files directly in batch.
 * @param {Array<{id: string, originalName: string, proposedName: string, folderId: string}>} requests
 * @return {Object} Results with success state and individual file messages.
 */
function batchRenameFiles(requests) {
  if (!Array.isArray(requests) || requests.length === 0) {
    return { success: false, message: "No rename requests provided." };
  }

  var results = [];

  for (var i = 0; i < requests.length; i++) {
    try {
      var result = renameFile(requests[i]);
      results.push({ index: i, success: true, message: result });
    } catch (err) {
      results.push({ index: i, success: false, message: err.message });
    }
  }

  return { success: true, results: results };
}

/**
 * Renames a single file in Drive using ID or flexible fallback searches.
 */
function renameFile() {
  var id = null;
  var originalName = null;
  var proposedName = null;
  var folderId = null;

  if (arguments.length > 0 && typeof arguments[0] === 'object' && arguments[0] !== null) {
    var data = arguments[0];
    id = data.id || data.fileId || null;
    originalName = data.originalName || data.name || null;
    proposedName = data.proposedName || data.newName || null;
    folderId = data.folderId || null;
  } else if (arguments.length === 2) {
    id = arguments[0];
    proposedName = arguments[1];
  }

  if (!proposedName) {
    throw new Error("Missing proposed new file name.");
  }

  var file = null;
  if (id && !String(id).startsWith('id-')) {
    try {
      file = DriveApp.getFileById(id);
    } catch (e) {
      console.warn("Could not find file by ID:", id);
    }
  }

  if (!file && originalName) {
    var search = folderId ? DriveApp.getFolderById(folderId).getFilesByName(originalName) : DriveApp.getFilesByName(originalName);
    if (search.hasNext()) file = search.next();
  }

  if (!file) {
    throw new Error("Target file not found in Google Drive.");
  }

  var oldName = file.getName();
  if (oldName === proposedName) {
    return 'File already named "' + proposedName + '"';
  }

  file.setName(proposedName);
  return 'Successfully renamed "' + oldName + '" to "' + proposedName + '"';
}
`;
  };

  const generateCloudDoc = () => {
    return `// Direct Google Drive REST API Batch Renaming (Cloud Mode)
// Scopes required: https://www.googleapis.com/auth/drive.file

async function renameInCloud(fileId, newName, accessToken) {
  const response = await fetch(
    \`https://www.googleapis.com/drive/v3/files/\${fileId}\`,
    {
      method: 'PATCH',
      headers: {
        'Authorization': \`Bearer \${accessToken}\`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: newName })
    }
  );

  if (!response.ok) {
    throw new Error(\`Rename failed: \${response.statusText}\`);
  }
  return await response.json();
}
`;
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    toast.success("Copied to clipboard!");
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="w-full min-h-screen bg-[#E4E3E0] text-[#141414] font-sans">
      <div className="max-w-7xl mx-auto p-4 md:p-6 space-y-6">
        
        {/* Header with Hybrid Routing Switcher */}
        <header className="border-b border-[#141414] pb-4 space-y-4">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-2xl md:text-3xl font-bold tracking-tighter uppercase">DriveRename AI</h1>
                <Badge variant="outline" className="border-[#141414] rounded-none px-2 py-0.5 text-[10px] uppercase font-mono bg-white/50">
                  Hybrid v2.0
                </Badge>
              </div>
              <p className="font-serif italic text-xs opacity-70 mt-1">
                Google Workspace File Renaming Specialist • Direct Drive API & Apps Script Bridge
              </p>
            </div>

            {/* Execution Environment Segmented Control */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 bg-white/60 p-1.5 border border-[#141414]">
              <span className="text-[10px] font-mono uppercase tracking-wider opacity-60 px-2 select-none self-center">
                Route Execution:
              </span>

              <div className="grid grid-cols-2 gap-1">
                <Button
                  variant={executionMode === "cloud" ? "default" : "ghost"}
                  size="sm"
                  onClick={() => setExecutionMode("cloud")}
                  className={`h-8 text-xs font-mono uppercase rounded-none transition-all ${
                    executionMode === "cloud"
                      ? "bg-[#141414] text-[#E4E3E0] shadow-none"
                      : "text-[#141414] hover:bg-[#141414]/10"
                  }`}
                >
                  <Cloud className="h-3.5 w-3.5 mr-1.5 text-sky-400" />
                  Cloud (Drive API)
                </Button>

                <Button
                  variant={executionMode === "local" ? "default" : "ghost"}
                  size="sm"
                  onClick={() => setExecutionMode("local")}
                  className={`h-8 text-xs font-mono uppercase rounded-none transition-all ${
                    executionMode === "local"
                      ? "bg-[#141414] text-[#E4E3E0] shadow-none"
                      : "text-[#141414] hover:bg-[#141414]/10"
                  }`}
                >
                  <Laptop className="h-3.5 w-3.5 mr-1.5 text-amber-400" />
                  Local (Apps Script)
                </Button>
              </div>
            </div>
          </div>

          {/* Environment Status & Authentication Bar */}
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 pt-2 text-xs font-mono bg-white/40 p-2.5 border border-[#141414]/15">
            <div className="flex items-center gap-2">
              <span className="opacity-50 text-[10px] uppercase">Active Target:</span>
              {executionMode === "cloud" ? (
                <div className="flex items-center gap-1.5 font-bold text-sky-900">
                  <Globe className="h-3.5 w-3.5 text-sky-600" />
                  <span>Google Drive REST API (Standalone & Picker)</span>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 font-bold text-emerald-900">
                  <Laptop className="h-3.5 w-3.5 text-emerald-600" />
                  <span>Google Workspace Add-on (Native Drive Session)</span>
                </div>
              )}
            </div>

            {/* Auth Actions in Cloud Mode vs Native Local Mode */}
            {executionMode === "cloud" ? (
              <div className="flex items-center gap-2">
                {currentUser ? (
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] opacity-75 truncate max-w-[180px]">
                      {currentUser.email || currentUser.displayName}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleGoogleSignOut}
                      className="h-6 px-2 text-[10px] uppercase font-mono rounded-none border-[#141414]/40 hover:bg-[#141414] hover:text-[#E4E3E0]"
                    >
                      <LogOut className="h-2.5 w-2.5 mr-1" /> Sign Out
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    onClick={handleGoogleSignIn}
                    disabled={authLoading}
                    className="h-7 px-3 text-[11px] uppercase font-mono rounded-none bg-blue-600 hover:bg-blue-700 text-white flex items-center gap-1.5 shadow-none"
                  >
                    {authLoading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ShieldCheck className="h-3.5 w-3.5" />
                    )}
                    Sign in with Google
                  </Button>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="border-emerald-700 text-emerald-800 bg-emerald-50 text-[10px] uppercase font-mono px-2 py-0.5 rounded-none flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                  Workspace Add-on Authenticated
                </Badge>
                <span className="text-[10px] opacity-60 hidden md:inline">
                  (Uses native DriveApp permissions via code.gs)
                </span>
              </div>
            )}
          </div>

          {/* Notice if Cloud mode is selected while inside Apps Script */}
          {isAppsScriptEnvironment && executionMode === "cloud" && (
            <div className="bg-amber-50 border border-amber-300 p-2.5 text-xs text-amber-900 font-mono flex items-start justify-between gap-3">
              <div className="flex items-start gap-2">
                <Info className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <span className="font-bold">Google Workspace Add-on Detected:</span> You are running inside Apps Script where Drive access is already authenticated natively! Switch to <strong>Local (Apps Script)</strong> mode to rename files directly without requiring Firebase Auth domain setup.
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setExecutionMode("local")}
                className="h-6 px-2.5 text-[10px] uppercase font-mono border-amber-800 text-amber-950 bg-amber-100 hover:bg-amber-200 shrink-0 rounded-none"
              >
                Switch to Local Mode
              </Button>
            </div>
          )}
        </header>

        {/* Main Content Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          
          {/* Left Column: Input, Picker & Rules Engine */}
          <div className="lg:col-span-4 space-y-6">
            
            {/* Target Files Selection Card */}
            <Card className="rounded-none border-[#141414] bg-white/40 shadow-none">
              <CardHeader className="border-b border-[#141414] pb-3">
                <div className="flex justify-between items-center gap-2">
                  <div>
                    <CardTitle className="text-xs uppercase tracking-widest font-mono">Target Files</CardTitle>
                    <CardDescription className="font-serif italic text-xs">
                      {selectedFiles.length > 0
                        ? `${selectedFiles.length} files selected (${selectedFiles[0]?.source === "picker" ? "Google Picker" : selectedFiles[0]?.source === "apps-script" ? "Apps Script" : "Manual"})`
                        : "Pick from Drive or enter filenames"}
                    </CardDescription>
                  </div>

                  {/* Mode-Specific Selection Action Buttons */}
                  <div className="flex items-center gap-1.5">
                    {executionMode === "cloud" ? (
                      <Button
                        variant="default"
                        size="sm"
                        onClick={handleOpenPicker}
                        disabled={pickingFiles}
                        className="h-7 text-[10px] uppercase font-mono rounded-none bg-[#141414] text-[#E4E3E0] hover:bg-[#141414]/80 px-2.5"
                      >
                        {pickingFiles ? (
                          <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
                        ) : (
                          <FolderOpen className="h-3 w-3 mr-1.5 text-sky-300" />
                        )}
                        Browse Drive (Picker)
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={fetchFilesFromAppsScript}
                        disabled={fetching}
                        className="h-7 text-[10px] uppercase font-mono border border-[#141414] rounded-none hover:bg-[#141414] hover:text-[#E4E3E0] px-2.5"
                      >
                        {fetching ? (
                          <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
                        ) : (
                          <RefreshCw className="h-3 w-3 mr-1.5" />
                        )}
                        Fetch Selected (.gs)
                      </Button>
                    )}
                  </div>
                </div>
              </CardHeader>

              <CardContent className="pt-4 space-y-3">
                {selectedFiles.length > 0 ? (
                  <div className="space-y-2">
                    <ScrollArea className="h-[180px] border border-[#141414]/20 bg-white/80 p-2 rounded-none">
                      <div className="space-y-1.5">
                        {selectedFiles.map((f) => (
                          <div
                            key={f.fileId}
                            className="flex justify-between items-center p-1.5 border-b border-[#141414]/5 text-[11px] font-mono group hover:bg-[#141414]/5"
                          >
                            <div className="flex items-center gap-2 truncate mr-2">
                              <FileText className="h-3.5 w-3.5 opacity-50 shrink-0" />
                              <span className="truncate">{f.currentName}</span>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              {f.source === "picker" && (
                                <Badge variant="outline" className="text-[8px] h-3.5 px-1 py-0 border-sky-600 text-sky-800 font-mono">
                                  Drive
                                </Badge>
                              )}
                              {f.content && f.content !== "[No text extracted]" && (
                                <Badge variant="secondary" className="text-[8px] h-3.5 px-1 py-0 bg-emerald-100 text-emerald-800 border-none font-mono">
                                  OCR
                                </Badge>
                              )}
                              <button
                                onClick={() => removeFile(f.fileId)}
                                className="opacity-0 group-hover:opacity-100 text-[#141414]/40 hover:text-red-600 transition-opacity p-0.5"
                                title="Remove file"
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                    <div className="flex justify-between items-center text-[10px] font-mono opacity-60">
                      <span>{selectedFiles.length} file(s) loaded</span>
                      <button
                        onClick={() => setSelectedFiles([])}
                        className="hover:underline uppercase text-[9px]"
                      >
                        Clear All
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Textarea
                      placeholder="Invoice-811B26A1-0001.pdf&#10;Invoice-1637E153-0012.pdf&#10;Receipt_May2024.pdf"
                      className="min-h-[130px] rounded-none border-[#141414]/30 focus-visible:ring-0 bg-white/80 font-mono text-xs"
                      value={fileInput}
                      onChange={(e) => setFileInput(e.target.value)}
                    />
                    <div className="text-[10px] font-mono opacity-50 flex items-center justify-between">
                      <span>Or enter one file name per line</span>
                      {executionMode === "cloud" && (
                        <button
                          onClick={handleOpenPicker}
                          className="text-blue-700 underline font-bold uppercase"
                        >
                          Use Google Picker →
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Workflow Mode Tabs (AI vs Rules) */}
            <div className="flex items-center gap-2 border-b border-[#141414] pb-2">
              <Button
                variant={activeWorkflow === "ai" ? "default" : "outline"}
                size="sm"
                onClick={() => setActiveWorkflow("ai")}
                className={`rounded-none text-xs font-mono uppercase h-8 px-4 flex-1 ${
                  activeWorkflow === "ai"
                    ? "bg-[#141414] text-[#E4E3E0]"
                    : "border-[#141414] bg-transparent text-[#141414] hover:bg-[#141414]/10"
                }`}
              >
                <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                AI Assistant (Gemini)
              </Button>
              <Button
                variant={activeWorkflow === "rules" ? "default" : "outline"}
                size="sm"
                onClick={() => setActiveWorkflow("rules")}
                className={`rounded-none text-xs font-mono uppercase h-8 px-4 flex-1 ${
                  activeWorkflow === "rules"
                    ? "bg-[#141414] text-[#E4E3E0]"
                    : "border-[#141414] bg-transparent text-[#141414] hover:bg-[#141414]/10"
                }`}
              >
                <SlidersHorizontal className="h-3.5 w-3.5 mr-1.5" />
                Quick Batch Rules
              </Button>
            </div>

            {/* Workflow 1: AI Prompt Intent */}
            {activeWorkflow === "ai" && (
              <Card className="rounded-none border-[#141414] bg-white/40 shadow-none">
                <CardHeader className="border-b border-[#141414] pb-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-xs uppercase tracking-widest font-mono flex items-center gap-1.5">
                        <Sparkles className="h-3.5 w-3.5 text-amber-600" />
                        Gemini AI Rename Intent
                      </CardTitle>
                      <CardDescription className="font-serif italic text-xs">
                        Uses document OCR text and contextual pattern intelligence
                      </CardDescription>
                    </div>
                    {/* Model & API Key Status Pills */}
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span
                        className="text-[10px] font-mono text-stone-600 bg-stone-100 px-1.5 py-0.5 border border-stone-300"
                        title="Google automatically routes this alias to the newest active Flash model"
                      >
                        {getActiveGeminiModel()} <span className="text-emerald-700 font-semibold">• evergreen</span>
                      </span>
                      {isKeyReady ? (
                        <button
                          type="button"
                          onClick={() => setShowKeyConfig((prev) => !prev)}
                          className="flex items-center gap-1 text-[10px] font-mono font-medium text-emerald-800 bg-emerald-100/80 px-2 py-0.5 border border-emerald-300 hover:bg-emerald-200 transition-colors"
                          title="Click to view or edit Gemini API key"
                        >
                          <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                          <span>Gemini Ready</span>
                          <Key className="h-2.5 w-2.5 ml-0.5 opacity-60" />
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setShowKeyConfig(true)}
                          className="flex items-center gap-1 text-[10px] font-mono font-bold text-amber-900 bg-amber-100 px-2 py-0.5 border border-amber-400 hover:bg-amber-200 transition-colors animate-pulse"
                          title="Configure your Gemini API key"
                        >
                          <Key className="h-3 w-3 text-amber-700" />
                          <span>Configure Key</span>
                        </button>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-4 space-y-4">
                  {/* API Key Configuration Panel */}
                  {(showKeyConfig || !isKeyReady) && (
                    <div className="p-3 bg-amber-50/70 border border-amber-300/80 space-y-2 text-xs font-mono">
                      <div className="flex items-center justify-between">
                        <span className="font-bold flex items-center gap-1 text-amber-950">
                          <Key className="h-3.5 w-3.5 text-amber-700" />
                          Gemini API Key Setup
                        </span>
                        {isKeyReady && (
                          <button
                            type="button"
                            onClick={() => setShowKeyConfig(false)}
                            className="text-[10px] text-amber-800 hover:underline"
                          >
                            Hide
                          </button>
                        )}
                      </div>
                      <p className="text-[11px] text-amber-900/80 font-sans">
                        In Google Workspace, this key is saved to your Apps Script Script Properties so it stays active across sessions.
                      </p>
                      <div className="flex gap-2">
                        <Input
                          type="password"
                          placeholder="Paste Gemini API key (AIza...)"
                          value={keyInput}
                          onChange={(e) => setKeyInput(e.target.value)}
                          className="rounded-none border-[#141414]/30 bg-white font-mono text-xs h-8 flex-1"
                        />
                        <Button
                          size="sm"
                          disabled={savingKey || !keyInput.trim()}
                          onClick={() => handleSaveGeminiKey(keyInput)}
                          className="rounded-none bg-[#141414] text-[#E4E3E0] hover:bg-[#141414]/90 h-8 font-mono text-xs uppercase shrink-0"
                        >
                          {savingKey ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Check className="h-3 w-3 mr-1" />}
                          Save Key
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* Intent input */}
                  <div className="space-y-1.5">
                    <label className="text-[10px] uppercase font-mono opacity-60">Instruction / Pattern</label>
                    <Input
                      placeholder="e.g. Add the invoice or receipt date to the start in format yyyyMMdd_"
                      className="rounded-none border-[#141414]/30 focus-visible:ring-0 bg-white/80 font-mono text-xs"
                      value={intent}
                      onChange={(e) => setIntent(e.target.value)}
                    />
                  </div>

                  {/* Complex Scenario Quick Presets */}
                  <div className="space-y-1.5 pt-1">
                    <span className="text-[10px] uppercase font-mono opacity-50 block">Complex Rename Presets:</span>
                    <div className="flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        onClick={() => setIntent("Extract invoice date and vendor name: YYYY-MM-DD_[Vendor]_[Invoice#].pdf")}
                        className="text-[10px] font-mono px-2 py-1 bg-white/80 hover:bg-[#141414] hover:text-[#E4E3E0] border border-[#141414]/20 transition-colors text-left"
                      >
                        📄 Invoices (OCR Date + Vendor)
                      </button>
                      <button
                        type="button"
                        onClick={() => setIntent("Extract agreement party name and execution date: [Party]_[DocType]_[YYYY-MM].pdf")}
                        className="text-[10px] font-mono px-2 py-1 bg-white/80 hover:bg-[#141414] hover:text-[#E4E3E0] border border-[#141414]/20 transition-colors text-left"
                      >
                        📑 Contracts & Agreements
                      </button>
                      <button
                        type="button"
                        onClick={() => setIntent("Prefix with receipt purchase date and merchant: YYYYMMDD_[Merchant]_[Total].pdf")}
                        className="text-[10px] font-mono px-2 py-1 bg-white/80 hover:bg-[#141414] hover:text-[#E4E3E0] border border-[#141414]/20 transition-colors text-left"
                      >
                        🧾 Receipts & Expenses
                      </button>
                      <button
                        type="button"
                        onClick={() => setIntent("Standardize dates to ISO YYYY-MM-DD, convert underscores to hyphens, and clean casing")}
                        className="text-[10px] font-mono px-2 py-1 bg-white/80 hover:bg-[#141414] hover:text-[#E4E3E0] border border-[#141414]/20 transition-colors text-left"
                      >
                        🧹 Normalize ISO & Case
                      </button>
                    </div>
                  </div>

                  <Button
                    onClick={handleAnalyze}
                    disabled={loading || currentWorkingFiles.length === 0}
                    className="w-full rounded-none bg-[#141414] text-[#E4E3E0] hover:bg-[#141414]/90 h-10 font-mono uppercase text-xs tracking-wider"
                  >
                    {loading ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Analyzing with Gemini...
                      </>
                    ) : (
                      <>
                        <Play className="mr-2 h-4 w-4" />
                        Analyze & Generate Suggestions
                      </>
                    )}
                  </Button>
                </CardContent>
              </Card>
            )}

            {/* Workflow 2: Quick Batch Rules */}
            {activeWorkflow === "rules" && (
              <Card className="rounded-none border-[#141414] bg-white/40 shadow-none">
                <CardHeader className="border-b border-[#141414] pb-3">
                  <CardTitle className="text-xs uppercase tracking-widest font-mono flex items-center gap-1.5">
                    <SlidersHorizontal className="h-3.5 w-3.5" />
                    Batch Rule Builder
                  </CardTitle>
                  <CardDescription className="font-serif italic text-xs">
                    Deterministic transformations (Prefix, Suffix, Replace, Case, Dates)
                  </CardDescription>
                </CardHeader>
                <CardContent className="pt-4 space-y-4">
                  
                  {/* Prefix & Suffix */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="text-[10px] uppercase font-mono opacity-60">Add Prefix</label>
                      <Input
                        placeholder="e.g. 2026_ or INV-"
                        className="rounded-none border-[#141414]/30 focus-visible:ring-0 bg-white/80 font-mono text-xs h-8"
                        value={prefix}
                        onChange={(e) => setPrefix(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] uppercase font-mono opacity-60">Add Suffix</label>
                      <Input
                        placeholder="e.g. _v1 or _FINAL"
                        className="rounded-none border-[#141414]/30 focus-visible:ring-0 bg-white/80 font-mono text-xs h-8"
                        value={suffix}
                        onChange={(e) => setSuffix(e.target.value)}
                      />
                    </div>
                  </div>

                  {/* Find & Replace */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="text-[10px] uppercase font-mono opacity-60 flex items-center gap-1">
                        <Replace className="h-2.5 w-2.5" /> Find Text
                      </label>
                      <Input
                        placeholder="e.g. Invoice-"
                        className="rounded-none border-[#141414]/30 focus-visible:ring-0 bg-white/80 font-mono text-xs h-8"
                        value={findText}
                        onChange={(e) => setFindText(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] uppercase font-mono opacity-60">Replace With</label>
                      <Input
                        placeholder="e.g. Bill-"
                        className="rounded-none border-[#141414]/30 focus-visible:ring-0 bg-white/80 font-mono text-xs h-8"
                        value={replaceText}
                        onChange={(e) => setReplaceText(e.target.value)}
                      />
                    </div>
                  </div>

                  {/* Case & Date Options */}
                  <div className="grid grid-cols-2 gap-3 pt-1">
                    <div className="space-y-1">
                      <label className="text-[10px] uppercase font-mono opacity-60">Change Case</label>
                      <select
                        value={caseTransform}
                        onChange={(e) => setCaseTransform(e.target.value as any)}
                        className="w-full h-8 text-xs font-mono bg-white/80 border border-[#141414]/30 px-2 rounded-none focus:outline-none"
                      >
                        <option value="none">Preserve Original</option>
                        <option value="lower">lowercase</option>
                        <option value="upper">UPPERCASE</option>
                        <option value="title">Title Case</option>
                        <option value="kebab">kebab-case</option>
                        <option value="snake">snake_case</option>
                      </select>
                    </div>

                    <div className="space-y-1">
                      <label className="text-[10px] uppercase font-mono opacity-60 flex items-center gap-1">
                        <Calendar className="h-2.5 w-2.5" /> Today's Date
                      </label>
                      <div className="flex items-center gap-2 h-8">
                        <Checkbox
                          id="date-stamp"
                          checked={includeDateStamp}
                          onCheckedChange={(c) => setIncludeDateStamp(!!c)}
                          className="border-[#141414] data-[state=checked]:bg-[#141414] data-[state=checked]:text-[#E4E3E0]"
                        />
                        <label htmlFor="date-stamp" className="text-xs font-mono cursor-pointer select-none">
                          Insert {getFormattedDate(dateStampFormat)}
                        </label>
                      </div>
                    </div>
                  </div>

                  {/* Sequential Numbering */}
                  <div className="border border-[#141414]/10 bg-white/50 p-2.5 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id="seq-toggle"
                          checked={addSequence}
                          onCheckedChange={(c) => setAddSequence(!!c)}
                          className="border-[#141414] data-[state=checked]:bg-[#141414] data-[state=checked]:text-[#E4E3E0]"
                        />
                        <label htmlFor="seq-toggle" className="text-xs font-mono cursor-pointer select-none flex items-center gap-1">
                          <Hash className="h-3 w-3 opacity-60" /> Number Sequence (e.g. prefix01- or suffix01)
                        </label>
                      </div>
                    </div>
                    {addSequence && (
                      <div className="grid grid-cols-2 gap-2 pt-1 text-[11px] font-mono">
                        <div>
                          <span className="opacity-60 text-[9px] uppercase block">Start At</span>
                          <Input
                            type="number"
                            min={1}
                            value={sequenceStart}
                            onChange={(e) => setSequenceStart(Math.max(1, parseInt(e.target.value) || 1))}
                            className="h-7 text-xs font-mono bg-white rounded-none border-[#141414]/30"
                          />
                        </div>
                        <div>
                          <span className="opacity-60 text-[9px] uppercase block">Padding Digits</span>
                          <Input
                            type="number"
                            min={1}
                            max={5}
                            value={sequencePadding}
                            onChange={(e) => setSequencePadding(Math.max(1, parseInt(e.target.value) || 2))}
                            className="h-7 text-xs font-mono bg-white rounded-none border-[#141414]/30"
                          />
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Live Transformation Preview Pill */}
                  {rulePreviewSamples.length > 0 && (
                    <div className="p-2.5 bg-[#141414]/5 border border-[#141414]/10 text-[11px] font-mono space-y-1">
                      <div className="text-[9px] uppercase tracking-wider opacity-50 font-bold">Live Rule Preview</div>
                      {rulePreviewSamples.map((item, idx) => (
                        <div key={idx} className="flex items-center gap-1.5 truncate">
                          <span className="truncate opacity-50 max-w-[42%]">{item.original}</span>
                          <ArrowRight className="h-2.5 w-2.5 shrink-0 opacity-40" />
                          <span className="truncate font-bold text-emerald-800">{item.proposed}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <Button
                    onClick={handleApplyRules}
                    disabled={currentWorkingFiles.length === 0}
                    className="w-full rounded-none bg-[#141414] text-[#E4E3E0] hover:bg-[#141414]/90 h-10 font-mono uppercase text-xs tracking-wider"
                  >
                    <Wand2 className="mr-2 h-4 w-4" />
                    Apply Batch Rules to Selection
                  </Button>
                </CardContent>
              </Card>
            )}

          </div>

          {/* Right Column: Review & Execution Table */}
          <div className="lg:col-span-8 space-y-6">
            <Tabs defaultValue="suggestions" className="w-full">
              <TabsList className="w-full justify-start rounded-none bg-transparent border-b border-[#141414] p-0 h-auto">
                <TabsTrigger
                  value="suggestions"
                  className="rounded-none border-b-2 border-transparent data-[state=active]:border-[#141414] data-[state=active]:bg-transparent px-5 py-2.5 text-xs uppercase font-mono"
                >
                  Review & Execute ({suggestions.length})
                </TabsTrigger>
                <TabsTrigger
                  value="code"
                  className="rounded-none border-b-2 border-transparent data-[state=active]:border-[#141414] data-[state=active]:bg-transparent px-5 py-2.5 text-xs uppercase font-mono"
                >
                  Integration Reference
                </TabsTrigger>
              </TabsList>

              {/* Suggestions & Review Tab */}
              <TabsContent value="suggestions" className="mt-6">
                <Card className="rounded-none border-[#141414] bg-white/40 shadow-none overflow-hidden">
                  
                  {/* Action Bar */}
                  <div className="p-3 border-b border-[#141414] flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 bg-white/70">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className="rounded-none border-[#141414]/40 font-mono text-[10px] uppercase">
                        {selectedIds.size} of {suggestions.length} selected
                      </Badge>
                      {suggestions.some((s) => s.status === "success") && (
                        <Badge variant="secondary" className="rounded-none bg-emerald-100 text-emerald-800 text-[10px] font-mono">
                          {suggestions.filter((s) => s.status === "success").length} Renamed
                        </Badge>
                      )}
                      <Badge variant="outline" className={`rounded-none text-[9px] font-mono uppercase ${
                        executionMode === "cloud" ? "border-sky-700 text-sky-800 bg-sky-50" : "border-amber-700 text-amber-800 bg-amber-50"
                      }`}>
                        Target: {executionMode === "cloud" ? "Cloud Drive API" : "Local Apps Script"}
                      </Badge>
                    </div>

                    <div className="flex items-center gap-2 w-full sm:w-auto">
                      <Button
                        onClick={handleExecuteRenaming}
                        disabled={renaming || selectedIds.size === 0}
                        size="sm"
                        className="rounded-none bg-[#141414] text-[#E4E3E0] hover:bg-[#141414]/90 h-8 text-[11px] uppercase font-mono tracking-wider w-full sm:w-auto px-4"
                      >
                        {renaming ? (
                          <>
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                            Executing {executionMode === "cloud" ? "Cloud" : "Local"} Rename...
                          </>
                        ) : (
                          <>
                            <Check className="mr-1.5 h-3.5 w-3.5" />
                            {executionMode === "cloud"
                              ? `Batch Rename in Drive (${selectedIds.size})`
                              : `Execute Local Batch (${selectedIds.size})`}
                          </>
                        )}
                      </Button>
                    </div>
                  </div>

                  {/* Table Area */}
                  <ScrollArea className="h-[520px]">
                    <Table className="w-full">
                      <TableHeader className="bg-[#141414] text-[#E4E3E0] sticky top-0 z-10">
                        <TableRow className="hover:bg-transparent border-none">
                          <TableHead className="w-[40px] text-[#E4E3E0]">
                            <Checkbox
                              checked={suggestions.length > 0 && selectedIds.size === suggestions.length}
                              onCheckedChange={toggleAll}
                              className="border-[#E4E3E0] data-[state=checked]:bg-[#E4E3E0] data-[state=checked]:text-[#141414]"
                            />
                          </TableHead>
                          <TableHead className="text-[#E4E3E0] text-[10px] uppercase font-mono w-[42%]">Original File</TableHead>
                          <TableHead className="text-[#E4E3E0] text-[10px] uppercase font-mono w-[46%]">Proposed Name (Click to edit)</TableHead>
                          <TableHead className="text-[#E4E3E0] text-[10px] uppercase font-mono w-[12%] text-right pr-4">Status</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {suggestions.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={4} className="text-center py-16 font-serif italic opacity-50 space-y-2">
                              <div>No suggestions or batch rules generated yet.</div>
                              <div className="text-xs font-mono uppercase not-italic opacity-40">
                                Select files with Google Picker, or click "Apply Batch Rules"
                              </div>
                            </TableCell>
                          </TableRow>
                        ) : (
                          suggestions.map((s) => (
                            <TableRow 
                              key={s.id} 
                              className={`border-b border-[#141414]/10 transition-colors ${
                                s.status === "success" 
                                  ? "bg-emerald-50/80 hover:bg-emerald-100/80" 
                                  : s.status === "error"
                                  ? "bg-rose-50/80 hover:bg-rose-100/80"
                                  : "hover:bg-[#141414]/5"
                              }`}
                            >
                              <TableCell className="align-middle">
                                <Checkbox
                                  checked={selectedIds.has(s.id)}
                                  onCheckedChange={() => toggleSelect(s.id)}
                                  className="border-[#141414] data-[state=checked]:bg-[#141414] data-[state=checked]:text-[#E4E3E0]"
                                />
                              </TableCell>

                              {/* Original Name */}
                              <TableCell className="font-mono text-xs align-middle py-3 pr-3">
                                <span className="font-medium break-all block text-[12px] leading-snug" title={s.originalName}>
                                  {s.originalName}
                                </span>
                                {s.reasoning && (
                                  <span className="text-[10px] opacity-50 block font-serif italic mt-0.5 break-all" title={s.reasoning}>
                                    {s.reasoning}
                                  </span>
                                )}
                              </TableCell>

                              {/* Proposed Name / Inline Editing */}
                              <TableCell className="font-mono text-xs align-middle py-3 pr-3">
                                {editingId === s.id ? (
                                  <div className="flex items-center gap-1.5 w-full">
                                    <Input
                                      value={tempEditedName}
                                      onChange={(e) => setTempEditedName(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") saveEditing(s.id);
                                        if (e.key === "Escape") setEditingId(null);
                                      }}
                                      autoFocus
                                      className="h-8 text-xs font-mono rounded-none border-[#141414] bg-white px-2 flex-1"
                                    />
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => saveEditing(s.id)}
                                      className="h-8 px-2.5 text-[10px] font-mono uppercase bg-[#141414] text-[#E4E3E0] hover:bg-[#141414]/80 rounded-none shrink-0"
                                    >
                                      Save
                                    </Button>
                                  </div>
                                ) : (
                                  <div 
                                    onClick={() => startEditing(s.id, s.proposedName)}
                                    className="group flex items-start justify-between cursor-pointer py-1 px-1.5 rounded hover:bg-white/90 border border-transparent hover:border-[#141414]/20 transition-all gap-2"
                                    title="Click to manually edit proposed name"
                                  >
                                    <span className="font-bold break-all text-[12px] text-emerald-950 leading-snug" title={s.proposedName}>
                                      {s.proposedName}
                                    </span>
                                    <Edit3 className="h-3 w-3 opacity-0 group-hover:opacity-60 transition-opacity shrink-0 mt-0.5" />
                                  </div>
                                )}
                              </TableCell>

                              {/* Status Badge */}
                              <TableCell className="text-right align-middle py-3 pr-4">
                                {s.status === "success" && (
                                  <Badge className="bg-emerald-700 text-white rounded-none text-[9px] font-mono uppercase gap-1">
                                    <CheckCircle2 className="h-2.5 w-2.5" /> Renamed
                                  </Badge>
                                )}
                                {s.status === "error" && (
                                  <Badge variant="destructive" className="rounded-none text-[9px] font-mono uppercase gap-1" title={s.errorMessage}>
                                    <XCircle className="h-2.5 w-2.5" /> Error
                                  </Badge>
                                )}
                                {(!s.status || s.status === "pending") && (
                                  <Badge variant="outline" className="border-[#141414]/30 rounded-none text-[9px] font-mono uppercase text-[#141414]/60">
                                    Ready
                                  </Badge>
                                )}
                              </TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </ScrollArea>
                </Card>
              </TabsContent>

              {/* Code & Integration Tab */}
              <TabsContent value="code" className="mt-6">
                <Card className="rounded-none border-[#141414] bg-white/40 shadow-none">
                  <CardHeader className="flex flex-row items-center justify-between border-b border-[#141414] pb-3 space-y-0">
                    <div>
                      <CardTitle className="text-xs uppercase tracking-widest font-mono">
                        {executionMode === "local" ? "Apps Script Bridge (.gs)" : "Direct Google Drive API (REST)"}
                      </CardTitle>
                      <CardDescription className="font-serif italic text-xs">
                        {executionMode === "local"
                          ? "Deploy inside Google Apps Script to run native Drive Add-on"
                          : "REST API endpoints used for Cloud mode batch operations"}
                      </CardDescription>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="rounded-none border-[#141414] h-7 text-xs font-mono uppercase hover:bg-[#141414] hover:text-[#E4E3E0]"
                      onClick={() =>
                        copyToClipboard(executionMode === "local" ? generateAppsScript() : generateCloudDoc())
                      }
                    >
                      {copied ? <Check className="h-3.5 w-3.5 mr-1" /> : <Copy className="h-3.5 w-3.5 mr-1" />}
                      Copy Code
                    </Button>
                  </CardHeader>
                  <CardContent className="p-0">
                    <ScrollArea className="h-[420px] bg-[#141414] text-[#E4E3E0] p-4 font-mono text-[11px] leading-relaxed">
                      <pre>{executionMode === "local" ? generateAppsScript() : generateCloudDoc()}</pre>
                    </ScrollArea>
                  </CardContent>
                </Card>
              </TabsContent>

            </Tabs>
          </div>

        </div>

        {/* Footer */}
        <footer className="pt-6 border-t border-[#141414] flex flex-col sm:flex-row justify-between items-center gap-2 opacity-50 text-[10px] uppercase font-mono">
          <span>DriveRename AI • Hybrid Execution Architecture</span>
          <span>Google Drive REST API (v3) & Google Apps Script Add-on Bridge</span>
        </footer>

      </div>
    </div>
  );
}
