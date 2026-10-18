// The ★ scenarios on the fake world.
import { createWorld } from '../harness/world.js'
import { starScenarios } from './star.js'

starScenarios(() => createWorld())
