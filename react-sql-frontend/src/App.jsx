import React from "react";
import Users from "./Users";
import "./App.css";
import packageJson from "../package.json";

const APP_VERSION = packageJson?.version || "0.0.0";

function App() {
  return (
    <div className="App">
      <Users />
      <div className="app-version-badge" aria-label={`App version ${APP_VERSION}`}>
        v{APP_VERSION}
      </div>
    </div>
  );
}

export default App;
