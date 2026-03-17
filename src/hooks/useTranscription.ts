import { useCallback, type Dispatch, type SetStateAction } from "react";
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { showFailureToast } from "@raycast/utils";
import {
  showToast,
  Toast,
  openExtensionPreferences,
  Clipboard,
  closeMainWindow,
  PopToRootType,
  showHUD,
  environment,
} from "@raycast/api";
import FormData from "form-data";
import fetch from "node-fetch";

// Define states
type CommandState =
  | "configuring"
  | "configured_waiting_selection"
  | "selectingPrompt"
  | "idle"
  | "recording"
  | "transcribing"
  | "done"
  | "error";

interface Config {
  execPath: string;
  modelPath: string;
  soxPath: string;
}

interface RemoteConfig {
  endpoint: string;
  model: string;
  apiKey: string;
}

const AUDIO_FILE_PATH = path.join(environment.supportPath, "raycast_dictate_audio.wav");
const WAV_HEADER_SIZE = 44;

interface UseTranscriptionProps {
  config: Config | null;
  remoteConfig: RemoteConfig | null;
  preferences: Preferences;
  setState: Dispatch<SetStateAction<CommandState>>;
  setErrorMessage: Dispatch<SetStateAction<string>>;
  setTranscribedText: Dispatch<SetStateAction<string>>;
  refineText: (text: string) => Promise<string>;
  saveTranscriptionToHistory: (text: string) => Promise<void>;
  cleanupAudioFile: () => void;
  aiErrorMessage: string;
  skipAIForSession: boolean;
}
/**
 * Hook that manages audio transcription using local whisper.cpp or remote OpenAI-compatible API.
 */
export function useTranscription({
  config,
  remoteConfig,
  preferences,
  setState,
  setErrorMessage,
  setTranscribedText,
  refineText,
  saveTranscriptionToHistory,
  cleanupAudioFile,
  aiErrorMessage,
  skipAIForSession,
}: UseTranscriptionProps) {
  const handlePasteAndCopy = useCallback(
    async (text: string) => {
      try {
        await Clipboard.copy(text);
        await Clipboard.paste(text);
        await showHUD("Copied and pasted transcribed text");
      } catch (error) {
        console.error("Error during copy and paste:", error);
        showFailureToast(error, { title: "Failed to copy and paste text" });
      }
      await Promise.all([
        cleanupAudioFile(),
        closeMainWindow({ clearRootSearch: true, popToRootType: PopToRootType.Immediate }),
      ]);
    },
    [cleanupAudioFile],
  );

  const handleTranscriptionResult = useCallback(
    async (rawText: string) => {
      let finalText = rawText;

      // Apply AI refinement if enabled and text is not empty and not skipped for session
      if (
        preferences.aiRefinementMethod !== "disabled" &&
        !skipAIForSession &&
        rawText &&
        rawText !== "[BLANK_AUDIO]"
      ) {
        try {
          finalText = await refineText(rawText);
        } catch (error) {
          console.error("AI refinement error during transcription handling:", error);
          // Error is already set by refineText, just use original text
          finalText = rawText;
        }
      } else {
        console.log("AI refinement skipped.");
      }

      setTranscribedText(finalText);
      await saveTranscriptionToHistory(finalText);
      setState("done");

      const DEFAULT_ACTION = preferences.defaultAction || "none";

      const handleClipboardActionAndClose = async (action: "paste" | "copy", text: string) => {
        if (action === "paste") {
          await Clipboard.paste(text);
          await showHUD("Pasted transcribed text");
        } else {
          await Clipboard.copy(text);
          await showHUD("Copied to clipboard");
        }
        await Promise.all([
          cleanupAudioFile(),
          closeMainWindow({ clearRootSearch: true, popToRootType: PopToRootType.Immediate }),
        ]);
      };

      if (DEFAULT_ACTION === "paste") {
        await handleClipboardActionAndClose("paste", finalText);
      } else if (DEFAULT_ACTION === "copy") {
        await handleClipboardActionAndClose("copy", finalText);
      } else if (DEFAULT_ACTION === "copy_paste") {
        await handlePasteAndCopy(finalText);
      } else {
        // Action is "none", stay in "done" state
        // Show success toast only if AI didn't fail (or wasn't used)
        if (preferences.aiRefinementMethod === "disabled" || skipAIForSession || !aiErrorMessage) {
          await showToast({ style: Toast.Style.Success, title: "Transcription complete" });
        }
        // Clean up file when staying in 'done' state
        cleanupAudioFile();
      }
    },
    [
      preferences,
      refineText,
      saveTranscriptionToHistory,
      setTranscribedText,
      setState,
      cleanupAudioFile,
      aiErrorMessage,
      handlePasteAndCopy,
      skipAIForSession,
    ],
  );

  const startTranscription = useCallback(async () => {
    const transcriptionMethod = preferences.transcriptionMethod || "remote";
    
    if (transcriptionMethod === "local" && !config) {
      console.error("startTranscription: Local configuration not available.");
      setErrorMessage("Configuration error occurred before transcription.");
      setState("error");
      return;
    }
    
    if (transcriptionMethod === "remote" && !remoteConfig) {
      console.error("startTranscription: Remote configuration not available.");
      setErrorMessage("Remote transcription configuration error. Check API endpoint and model settings.");
      setState("error");
      return;
    }

    setState("transcribing");
    showToast({ style: Toast.Style.Animated, title: "Transcribing..." });
    console.log("Set state to transcribing.");

    await new Promise((resolve) => setTimeout(resolve, 300));

    console.log(`Checking for audio file: ${AUDIO_FILE_PATH}`);
    try {
      const stats = await fs.promises.stat(AUDIO_FILE_PATH);
      console.log(`Audio file stats: ${JSON.stringify(stats)}`);
      if (stats.size <= WAV_HEADER_SIZE) {
        throw new Error(
          `Audio file is empty or too small (size: ${stats.size} bytes). Recording might have failed or captured no sound.`,
        );
      }
      console.log(`Audio file exists and has size ${stats.size}. Proceeding with transcription.`);
    } catch (error: unknown) {
      console.error(`Audio file check failed: ${AUDIO_FILE_PATH}`, error);
      const err = error as NodeJS.ErrnoException;
      const errorMsg =
        err.code === "ENOENT"
          ? `Transcription failed: Audio file not found. Recording might have failed.`
          : `Transcription failed: Cannot access audio file. ${err.message}`;
      setErrorMessage(errorMsg);
      setState("error");
      cleanupAudioFile();
      return;
    }

    if (transcriptionMethod === "remote") {
      await transcribeRemote();
    } else {
      await transcribeLocal();
    }
  }, [config, remoteConfig, preferences, setState, setErrorMessage, handleTranscriptionResult, cleanupAudioFile]);

  const transcribeRemote = useCallback(async () => {
    if (!remoteConfig) {
      setErrorMessage("Remote configuration not available.");
      setState("error");
      return;
    }

    console.log(`Starting remote transcription with model: ${remoteConfig.model} at ${remoteConfig.endpoint}`);

    try {
      const audioBuffer = await fs.promises.readFile(AUDIO_FILE_PATH);
      const formData = new FormData();
      formData.append("file", audioBuffer, {
        filename: "audio.wav",
        contentType: "audio/wav",
      });
      formData.append("model", remoteConfig.model);

      const endpoint = remoteConfig.endpoint.endsWith("/")
        ? remoteConfig.endpoint.slice(0, -1)
        : remoteConfig.endpoint;
      const url = `${endpoint}/v1/audio/transcriptions`;

      console.log(`Sending transcription request to: ${url}`);

      const headers: Record<string, string> = {};
      if (formData.getHeaders) {
        Object.assign(headers, formData.getHeaders());
      }
      if (remoteConfig.apiKey) {
        headers["Authorization"] = `Bearer ${remoteConfig.apiKey}`;
      }

      const response = await fetch(url, {
        method: "POST",
        headers: headers,
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMsg = `Remote transcription failed (${response.status}): ${errorText}`;
        
        if (response.status === 401) {
          errorMsg = "Authentication failed. Check your API key.";
        } else if (response.status === 404) {
          errorMsg = `Endpoint not found: ${url}. Check the API endpoint URL.`;
        } else if (response.status === 400) {
          errorMsg = `Bad request: ${errorText}. The audio format or model may not be supported.`;
        }
        
        throw new Error(errorMsg);
      }

      const result = (await response.json()) as { text?: string };
      const transcribedText = result.text?.trim() || "[BLANK_AUDIO]";

      console.log("Remote transcription successful.");
      console.log("Transcribed text:", transcribedText);

      await handleTranscriptionResult(transcribedText);
    } catch (error) {
      console.error("Remote transcription error:", error);
      const errMsg = error instanceof Error ? error.message : "Unknown error during remote transcription.";
      setErrorMessage(errMsg);
      setState("error");
      cleanupAudioFile();

      await showFailureToast(errMsg, {
        title: "Remote Transcription Failed",
        primaryAction: {
          title: "Open Extension Preferences",
          onAction: () => openExtensionPreferences(),
        },
      });
    }
  }, [remoteConfig, handleTranscriptionResult, cleanupAudioFile, setErrorMessage, setState]);

  const transcribeLocal = useCallback(async () => {
    if (!config) {
      setErrorMessage("Local configuration not available.");
      setState("error");
      return;
    }

    console.log(`Starting local transcription with model: ${config.modelPath}`);

    // Execute whisper-cli
    execFile(
      config.execPath,
      ["-m", config.modelPath, "-f", AUDIO_FILE_PATH, "-l", "auto", "-otxt", "--no-timestamps"],
      async (error, stdout, stderr) => {
        if (error) {
          console.error("whisper exec error:", error);
          console.error("whisper stderr:", stderr);

          let title = "Transcription Failed";
          let errMsg = `An unknown error occurred during transcription.`;

          const stderrStr = stderr?.toString() || "";
          const errorMsgStr = error?.message || "";

          if (stderrStr.includes("invalid model") || stderrStr.includes("failed to load model")) {
            title = "Model Error";
            errMsg = `The model file at '${config.modelPath}' is invalid, incompatible, or failed to load. Please check the model file, if it's compatible with whisper.cpp (ggml) or select a different one in preferences.`;
          } else if (stderrStr.includes("No such file or directory") || errorMsgStr.includes("ENOENT")) {
            if (errorMsgStr.includes(config.execPath)) {
              title = "Whisper Executable Not Found";
              errMsg = `The whisper executable was not found at '${config.execPath}'. Please verify the path in preferences.`;
            } else if (stderrStr.includes(config.modelPath) || errorMsgStr.includes(config.modelPath)) {
              title = "Model File Not Found";
              errMsg = `The model file specified at '${config.modelPath}' was not found. Please check the path in preferences or download the model using the Download whisper model command.`;
            } else {
              title = "File Not Found";
              errMsg = `A required file or directory was not found. Double check your whisper-cli and model path. ${stderrStr}`;
            }
          } else if (stderrStr) {
            errMsg = `Transcription failed. Details: ${stderrStr}`;
          } else {
            errMsg = `Transcription failed: ${error.message}`;
          }

          setErrorMessage(errMsg);
          setState("error");
          cleanupAudioFile(); // Clean up on exec error

          await showFailureToast(errMsg, {
            title: title,
            primaryAction: {
              title: "Open Extension Preferences",
              onAction: () => openExtensionPreferences(),
            },
          });
        } else {
          console.log("Local transcription successful.");
          const trimmedText = stdout.trim() || "[BLANK_AUDIO]";
          console.log("Transcribed text:", trimmedText);
          // Pass text to handler to set state/save history/refine/etc.
          await handleTranscriptionResult(trimmedText);
        }
      },
    );
  }, [config, handleTranscriptionResult, cleanupAudioFile, setErrorMessage, setState]);

  return { startTranscription, handlePasteAndCopy };
}
