import React from "react";
import ReactDOM from "react-dom/client";
import { createTheme } from "@mui/material/styles";
import CssBaseline from "@mui/material/CssBaseline";
import { DockerMuiV6ThemeProvider  } from "@docker/docker-mui-theme";
import './main.css';

import { App } from './App';

window.__ddMuiV6Themes = {
  dark: createTheme({
    palette: {
      mode: "dark",
      background: {
        default: "#202C33",
      },
    }
  }),
  light: createTheme({
    palette: {
      mode: "light",
      background: {
        default: "#f5f6fa",
      },
    }
  })
};

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <DockerMuiV6ThemeProvider >
      <CssBaseline />
      <App />
    </DockerMuiV6ThemeProvider >
  </React.StrictMode>
);
