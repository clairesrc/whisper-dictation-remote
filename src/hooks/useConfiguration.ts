import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  getPreferenceValues,
  LocalStorage,
  openExtensionPreferences,
  launchCommand,
  LaunchType,
  closeMainWindow,
} from "@raycast/api";
import fs from "fs";
import { showFailureToast } from "@raycast/utils"; // Added import

const DOWNLOADED_MODEL_PATH_KEY = "downloadedModelPath";

//Define states
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

export function useConfiguration(
  setState: Dispatch<SetStateAction<CommandState>>,
  setConfig: Dispatch<SetStateAction<Config | null>>,
  setErrorMessage: Dispatch<SetStateAction<string>>,
  setRemoteConfig: Dispatch<SetStateAction<RemoteConfig | null>>,
) {
  const preferences = getPreferenceValues<Preferences>();

  useEffect(() => {
    let isMounted = true;

    async function checkConfiguration() {
      setState("configuring");
      const transcriptionMethod = preferences.transcriptionMethod || "remote";

      const soxPath = preferences.soxExecutablePath;
      if (!soxPath || !fs.existsSync(soxPath)) {
        const errorMsg = `SoX executable not found or not set at '${soxPath || "not set"}'. Please install SoX (e.g., 'brew install sox') and set the correct path in preferences.`;
        setErrorMessage(errorMsg);
        setState("error");
        await showFailureToast(errorMsg, {
          title: "SoX Executable Not Found",
          primaryAction: {
            title: "Open Extension Preferences",
            onAction: () => openExtensionPreferences(),
          },
        });
        return;
      }

      const remoteConfig: RemoteConfig = {
        endpoint: preferences.remoteTranscriptionEndpoint || "https://litellm.bread.monster",
        model: preferences.remoteTranscriptionModel || "voxtral-mini",
        apiKey: preferences.remoteTranscriptionApiKey || "",
      };

      if (transcriptionMethod === "remote") {
        if (isMounted) {
          setRemoteConfig(remoteConfig);
          setConfig({
            execPath: "",
            modelPath: "",
            soxPath: preferences.soxExecutablePath,
          });
          setErrorMessage("");
          setState("configured_waiting_selection");
        }
        return;
      }

      const whisperExec = preferences.whisperExecutable;
      if (!whisperExec || !fs.existsSync(whisperExec)) {
        const errorMsg = `Whisper executable not found at '${whisperExec || "not set"}'.\n\nEnsure whisper.cpp is installed and the path in preferences is correct.\nCommon paths:\n- Homebrew (Apple Silicon): /opt/homebrew/bin/whisper-cli\n- Homebrew (Intel): /usr/local/bin/whisper-cli`;
        setErrorMessage(errorMsg);
        setState("error");
        await showFailureToast(errorMsg, {
          title: "Whisper Executable Not Found",
          primaryAction: {
            title: "Open Extension Preferences",
            onAction: () => openExtensionPreferences(),
          },
        });
        return;
      }

      let finalModelPath = "";
      try {
        const downloadedPath = await LocalStorage.getItem<string>(DOWNLOADED_MODEL_PATH_KEY);
        if (preferences.modelPath && fs.existsSync(preferences.modelPath)) {
          finalModelPath = preferences.modelPath;
        } else if (downloadedPath && fs.existsSync(downloadedPath)) {
          finalModelPath = downloadedPath;
        } else {
          const errorMsg =
            "No Whisper model found. Please run the 'Download Whisper Model' command or configure the path override in preferences.";
          setErrorMessage(errorMsg);
          setState("error");
          await showFailureToast(errorMsg, {
            title: "Whisper Model Not Found",
            primaryAction: {
              title: "Download Model",
              onAction: async () => {
                await launchCommand({ name: "download-model", type: LaunchType.UserInitiated });
                closeMainWindow();
              },
            },
          });
          return;
        }
      } catch (error) {
        const errorMsg = "Error accessing configuration. Check console logs.";
        console.error("Configuration error:", error);
        setErrorMessage(errorMsg);
        setState("error");
        await showFailureToast(errorMsg, { title: "Configuration Error" });
        return;
      }

      if (isMounted) {
        setConfig({
          execPath: preferences.whisperExecutable,
          modelPath: finalModelPath,
          soxPath: preferences.soxExecutablePath,
        });
        setRemoteConfig(remoteConfig);
        setErrorMessage("");
        setState("configured_waiting_selection");
      }
    }

    checkConfiguration();

    return () => {
      isMounted = false;
    };
  }, [preferences.whisperExecutable, preferences.modelPath, preferences.soxExecutablePath, preferences.transcriptionMethod, preferences.remoteTranscriptionEndpoint, preferences.remoteTranscriptionModel, preferences.remoteTranscriptionApiKey]);
}
