// TabBar - navigation tabs (hidden for now)
import React from "react";

type Tab = "dex" | "assets";

interface TabBarProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
}

export function TabBar({ activeTab, onTabChange }: TabBarProps) {
  return (
    <div className="tabs">
      <button
        className={`tab ${activeTab === "dex" ? "active" : ""}`}
        onClick={() => onTabChange("dex")}
      >
        DEX
      </button>
      <button
        className={`tab ${activeTab === "assets" ? "active" : ""}`}
        onClick={() => onTabChange("assets")}
      >
        ASSETS
      </button>
    </div>
  );
}

