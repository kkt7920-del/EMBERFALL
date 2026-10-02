import { DAY_LENGTH_SECONDS } from "../config/constants";
import type { TimePeriod, Weather } from "../types/content";
import type { WorldClock } from "../types/game";

/** In-game time starts at 08:00. */
const START_HOUR = 8;

export function hourAt(time: number): number {
  return (((time / DAY_LENGTH_SECONDS) * 24 + START_HOUR) % 24 + 24) % 24;
}

export function periodForHour(hour: number): TimePeriod {
  if (hour >= 5 && hour < 7) return "dawn";
  if (hour >= 7 && hour < 17.5) return "day";
  if (hour >= 17.5 && hour < 19.5) return "dusk";
  return "night";
}

export function clockAt(time: number, weather: Weather): WorldClock {
  const hour = hourAt(time);
  return { time, hour, period: periodForHour(hour), weather };
}

/** World time at which the given hour next occurs after `time`. */
export function timeAtHour(time: number, hour: number): number {
  const current = hourAt(time);
  let delta = hour - current;
  if (delta < 0) delta += 24;
  return time + (delta / 24) * DAY_LENGTH_SECONDS;
}
