import type { Confidence, RiskLevel, ShipmentStatus } from "../api/contract";

/*
  Words for the API's risk levels. This is display only: the level itself always comes from the API.
  Customers see the plain words from DESIGN.md 7.4; staff see the same words, so one vocabulary is used everywhere.
*/
export const RISK_WORD: Record<RiskLevel, string> = {
  LOW: "On schedule",
  MEDIUM: "At risk",
  HIGH: "Delayed",
};

export const CONFIDENCE_WORD: Record<Confidence, string> = {
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
};

export const STATUS_WORD: Record<ShipmentStatus, string> = {
  PLANNED: "Planned",
  DISPATCHED: "Dispatched",
  IN_TRANSIT: "In transit",
  ARRIVED: "Arrived",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
};

export const CATEGORY_WORD: Record<string, string> = {
  ACCIDENT: "Accident",
  BREAKDOWN: "Breakdown",
  WEATHER: "Weather",
  ROAD_CLOSURE: "Road closed",
  LOADING_DELAY: "Loading delay",
  OTHER: "Other problem",
  CONGESTION: "Slow traffic",
  BASE_TRAVEL: "Driving time",
  DWELL: "Planned stops",
  STALE_POSITION: "No recent position",
};
