import _ceil from 'lodash/ceil';
import _floor from 'lodash/floor';
import _isNil from 'lodash/isNil';
import _isObject from 'lodash/isObject';
import _isEmpty from 'lodash/isEmpty';
import RouteModel from '../../navigationLibrary/Route/RouteModel';
import { clamp } from '../../math/core';
import {
    groupNumbers,
    radio_altitude,
    radio_heading,
    radio_runway,
    radio_spellOut,
    radio_trend,
    getRadioCardinalDirectionNameForHeading
} from '../../utilities/radioUtilities';
import {
    degreesToRadians,
    heading_to_string
} from '../../utilities/unitConverters';
import { radians_normalize } from '../../math/circle';
import {
    FLIGHT_CATEGORY,
    FLIGHT_PHASE
} from '../../constants/aircraftConstants';
import { MCP_MODE } from '../ModeControl/modeControlConstants';

/**
 * Executes control actions upon the aircraft by manipulating the MCP and FMS, and provides
 * readbacks to air traffic control instructions.
 *
 * @class Pilot
 */
export default class Pilot {
    /**
     * @for Pilot
     * @constructor
     * @param modeController {ModeController}
     * @param fms {Fms}
     */
    constructor(modeController, fms) {
        if (!_isObject(modeController) || _isEmpty(modeController)) {
            throw new TypeError('Invalid parameter. expected modeController to an instance of ModeController');
        }

        if (!_isObject(fms) || _isEmpty(fms)) {
            throw new TypeError('Invalid parameter. expected fms to an instance of Fms');
        }

        /**
         * @property _mcp
         * @type {ModeController}
         * @default modeController
         * @private
         */
        this._mcp = modeController;

        /**
         * @property _fms
         * @type {Fms}
         * @default fms
         * @private
         */
        this._fms = fms;

        /**
         * Whether the aircraft has received a clearance to conduct an approach to a runway
         *
         * @property hasApproachClearance
         * @type {boolean}
         * @default false
         */
        this.hasApproachClearance = false;

        /**
         * Whether the aircraft has received an IFR clearance to their destination
         *
         * @property hasDepartureClearance
         * @type {boolean}
         * @default false
         */
        this.hasDepartureClearance = false;
    }

    /**
     * @for Pilot
     * @method enable
     */
    enable() {
        return;
    }

    /**
     * @for Pilot
     * @method destroy
     */
    destroy() {
        this._mcp = null;
        this._fms = null;
        this.hasApproachClearance = false;
    }

    /**
     * Maintain a given altitude
     *
     * @for Pilot
     * @method maintainAltitude
     * @param altitude {number}   the altitude to maintain, in feet
     * @param expedite {boolean}  whether to use maximum possible climb/descent rate
     * @return {array}            [success of operation, readback]
     */
    maintainAltitude(currentAltitude, altitude, expedite, shouldUseSoftCeiling, airportModel) {
        const { minAssignableAltitude, maxAssignableAltitude } = airportModel;
        let clampedAltitude = clamp(minAssignableAltitude, altitude, maxAssignableAltitude);

        if (shouldUseSoftCeiling && clampedAltitude === maxAssignableAltitude) {
            // causes aircraft to 'leave' airspace, and continue climb through ceiling
            clampedAltitude += 1;
        }

        this._mcp.setAltitudeFieldValue(clampedAltitude);
        this._mcp.setAltitudeHold();

        // TODO: this could be split to another method
        // Build readback
        const readbackAltitude = _floor(clampedAltitude, -2);
        const altitudeInstruction = radio_trend('altitude', currentAltitude, altitude);
        const altitudeVerbal = radio_altitude(readbackAltitude);
        let expediteReadback = '';

        if (expedite) {
            // including space here so when expedite is false there isnt an extra space after altitude
            expediteReadback = ' and expedite';

            this.shouldExpediteAltitudeChange();
        }

        const readback = {};
        readback.log = `${altitudeInstruction} ${readbackAltitude}${expediteReadback}`;
        readback.say = `${altitudeInstruction} ${altitudeVerbal}${expediteReadback}`;

        return [true, readback];
    }

    /**
     * Maintain a given heading
     *
     * @for Pilot
     * @method maintainHeading
     * @param currentHeading {number}
     * @param heading        {number}                   the heading to maintain, in radians_normalize
     * @param direction      {string|null}  (optional)  the direction of turn; either 'left' or 'right'
     * @param incremental    {boolean}      (optional)  whether the value is a numeric heading, or a
     *                                                  number of degrees to turn
     * @return {array}                                  [success of operation, readback]
     */
    maintainHeading(currentHeading, headingOrDegrees, direction, incremental) {
        const nextHeadingInRadians = degreesToRadians(headingOrDegrees);
        let correctedHeading = nextHeadingInRadians;

        if (incremental) {
            // if direction is left
            correctedHeading = radians_normalize(currentHeading - nextHeadingInRadians);

            if (direction === 'right') {
                correctedHeading = radians_normalize(currentHeading + nextHeadingInRadians);
            }
        }

        this._fms.exitHoldIfHolding();
        this._mcp.setHeadingHold();
        this._mcp.setHeadingFieldValue(correctedHeading);

        const headingStr = heading_to_string(correctedHeading);
        const readback = {};
        readback.log = `fly heading ${headingStr}`;
        readback.say = `fly heading ${radio_heading(headingStr)}`;

        if (incremental) {
            readback.log = `turn ${headingOrDegrees} degrees ${direction}`;
            readback.say = `turn ${groupNumbers(headingOrDegrees)} degrees ${direction}`;
        } else if (direction) {
            readback.log = `turn ${direction} heading ${headingStr}`;
            readback.say = `turn ${direction} heading ${radio_heading(headingStr)}`;
        }

        return [true, readback];
    }

    /**
     * Maintain the aircraft's present magnetic heading
     *
     * @for Pilot
     * @method maintainPresentHeading
     * @param heading {number}  the heading the aircraft is facing at the time the command is given
     * @return {array}          [success of operation, readback]
     */
    maintainPresentHeading(heading) {
        this._mcp.setHeadingHold();
        this._mcp.setHeadingFieldValue(heading);

        const readback = {};
        readback.log = 'fly present heading';
        readback.say = 'fly present heading';

        return [true, readback];
    }

    /**
     * Maintain a given speed
     *
     * @for Pilot
     * @method maintainSpeed
     * @param {Number} speed - the speed to maintain, in knots
     * @return {Array} [success of operation, readback]
     */
    maintainSpeed(currentSpeed, speed) {
        const instruction = radio_trend('speed', currentSpeed, speed);

        this._mcp.setSpeedHold();
        this._mcp.setSpeedFieldValue(speed);

        // Build the readback
        const readback = {};
        readback.log = `${instruction} ${speed}`;
        readback.say = `${instruction} ${radio_spellOut(speed)}`;

        return [true, readback];
    }

    /**
     * Apply the specified arrival procedure by adding it to the fms route
     * Note: SHOULD NOT change the heading mode
     *
     * @for Pilot
     * @method applyArrivalProcedure
     * @param routeString {String}  route string in the form of `entry.procedure.airport`
     * @return {Array}              [success of operation, readback]
     */
    applyArrivalProcedure(routeString, arrivalRunway, airportName) {
        if (!this._fms.isValidProcedureRoute(routeString, arrivalRunway, FLIGHT_CATEGORY.ARRIVAL)) {
            // TODO: may need a better message here
            return [false, 'STAR name not understood'];
        }

        const routeStringModel = new RouteModel(routeString);
        const starModel = this._fms.findStarByProcedureId(routeStringModel.procedure);

        // TODO: set mcp modes here
        this._fms.replaceArrivalProcedure(routeStringModel.routeCode, arrivalRunway);

        // Build readback
        const readback = {};
        readback.log = `cleared to ${airportName} via the ${routeStringModel.procedure} arrival`;
        readback.say = `cleared to ${airportName} via the ${starModel.name.toUpperCase()} arrival`;

        return [true, readback];
    }

    /**
     * Apply the specified departure procedure by adding it to the fms route
     * Note: SHOULD NOT change the heading mode
     *
     * @for Pilot
     * @method applyDepartureProcedure
     * @param procedureId {String}                the identifier for the procedure
     * @param departureRunwayModel {RunwayModel}  the identifier for the runway to use for departure
     * @param airportIcao {string}                airport icao identifier
     * @return {array}                            [success of operation, readback]
     */
    applyDepartureProcedure(procedureId, departureRunwayModel, airportIcao) {
        this.hasDepartureClearance = true;

        const standardRouteModel = this._fms.findSidByProcedureId(procedureId);

        if (_isNil(standardRouteModel)) {
            return [false, 'SID name not understood'];
        }

        // TODO: this should not be randomized
        const exit = this._fms.findRandomExitPointForSidProcedureId(procedureId);
        const routeStr = `${airportIcao}.${procedureId}.${exit}`;

        if (!departureRunwayModel) {
            return [false, 'unsure if we can accept that procedure; we don\'t have a runway assignment'];
        }

        if (!standardRouteModel.hasFixName(departureRunwayModel.name)) {
            return [
                false,
                `unable, the ${standardRouteModel.name.toUpperCase()} departure not valid ` +
                `from Runway ${departureRunwayModel.name.toUpperCase()}`
            ];
        }

        this._mcp.setAltitudeVnav();
        this._mcp.setSpeedVnav();
        this._fms.replaceDepartureProcedure(routeStr, departureRunwayModel);

        const readback = {};
        readback.log = `cleared to destination via the ${procedureId} departure, then as filed`;
        readback.say = `cleared to destination via the ${standardRouteModel.name} departure, then as filed`;

        return [true, readback];
    }

    /**
     * Replace the entire route stored in the FMS with legs freshly generated
     * based on the provided route string
     *
     * @for Pilot
     * @method applyNewRoute
     * @param routeString {string}  routeString defining the new route to use
     * @return {array}              [success of operation, readback]
     */
    applyNewRoute(routeString, runway) {
        this.hasDepartureClearance = true;

        const isValid = this._fms.isValidRoute(routeString, runway);

        if (!isValid) {
            const readback = {};
            readback.log = `requested route of "${routeString}" is invalid`;
            readback.say = 'that route is invalid';

            return [false, readback];
        }

        this._fms.replaceFlightPlanWithNewRoute(routeString, runway);

        // Build readback
        const readback = {};
        readback.log = `rerouting to: ${this._fms.currentRoute}`;
        readback.say = 'rerouting as requested';

        return [true, readback];
    }

    /**
     * Apply the specified route, and as applicable, merge it with the current route
     *
     * @for Pilot
     * @method applyPartialRouteAmendment
     * @param routeString {tring}  route string in the form of `entry.procedure.airport`
     * @return {array}             [success of operation, readback]
     */
    applyPartialRouteAmendment(routeString) {
        const isValid = this._fms.isValidRoute(routeString);

        if (!isValid) {
            return [false, `requested route of "${routeString.toUpperCase()}" is invalid`];
        }

        if (!this._fms.isValidRouteAmendment(routeString)) {
            return [
                false,
                `requested route of "${routeString.toUpperCase()}" is invalid, it must contain a Waypoint in the current route`
            ];
        }

        this._fms.replaceRouteUpToSharedRouteSegment(routeString);
        this._fms.exitHoldIfHolding();

        // Build readback
        const readback = {};
        readback.log = `rerouting to: ${this._fms.currentRoute.toUpperCase()}`;
        readback.say = 'rerouting as requested';

        return [true, readback];
    }

    /**
     * Stop conducting the instrument approach; maintain present speed/heading, and climb
     * to a reasonable altitude
     *
     * @for Pilot
     * @method cancelApproachClearance
     * @param heading {number}           the aircraft's current heading
     * @param speed {number}             the aircraft's current speed
     * @param airportElevation {number}  the elevation of the airport, in feet MSL
     * @return {array}                   [success of operation, readback]
     */
    cancelApproachClearance(heading, speed, airportElevation) {
        const initialMissedApproachAltitude = _ceil(airportElevation, -2) + 1000;

        this._mcp.setHeadingHold();
        this._mcp.setHeadingFieldValue(heading);
        this._mcp.setAltitudeHold();
        this._mcp.setAltitudeFieldValue(initialMissedApproachAltitude);
        this._mcp.setSpeedHold();
        this._mcp.setSpeedFieldValue(speed);

        const readback = {};
        readback.log = `cancel approach clearance, fly present heading, maintain ${initialMissedApproachAltitude}`;
        readback.say = `cancel approach clearance, fly present heading, maintain ${radio_altitude(initialMissedApproachAltitude)}`;

        return [true, readback];
    }

    /**
     * Configure the aircraft to fly in accordance with the requested flightplan
     *
     * @for Pilot
     * @method clearedAsFiled
     * @param {Number} initialAltitude  the altitude aircraft can automatically climb to at this airport
     * @return {Array}                  [success of operation, readback]
     */
    clearedAsFiled() {
        this.hasDepartureClearance = true;

        const readback = {};
        readback.log = 'cleared to destination as filed';
        readback.say = 'cleared to destination as filed';

        return [true, readback];
    }

    /**
     * Climb in accordance with the altitude restrictions, and sets
     * altitude at which the climb will end regardless of fix restrictions.
     *
     * @for Pilot
     * @method climbViaSid
     * @return {array}           [success of operation, readback]
     */
    climbViaSid() {
        if (this._fms.flightPlanAltitude === -1) {
            const readback = {};
            readback.log = 'unable to climb via SID, no altitude assigned';
            readback.say = 'unable to climb via SID, no altitude assigned';

            return [false, readback];
        }

        this._mcp.setAltitudeFieldValue(this._fms.flightPlanAltitude);
        this._mcp.setAltitudeVnav();

        const readback = {};
        readback.log = 'climb via SID';
        readback.say = 'climb via SID';

        return [true, readback];
    }

    /**
     * Descend in accordance with the altitude restrictions
     *
     * @for Pilot
     * @method descendViaStar
     * @param altitude {number}  (optional) altitude at which the descent will end (regardless of fix restrictions)
     *                                      this should be the altitude of the lowest fix restriction on the STAR
     * @return {array}           [success of operation, readback]
     */
    descendViaStar(altitude = 0) {
        this._mcp.setAltitudeFieldValue(altitude);
        this._mcp.setAltitudeVnav();
        this._mcp.setSpeedVnav();

        // Build readback
        const readback = {};
        readback.log = 'descend via the arrival';
        readback.say = 'descend via the arrival';

        return [true, readback];
    }

    /**
     * Abort the landing attempt; maintain present heading/speed, and climb to a reasonable alttiude
     *
     * @for Pilot
     * @method goAround
     * @param heading {number}           the aircraft's current heading
     * @param speed {number}             the aircraft's current speed
     * @param airportElevation {number}  the elevation of the airport, in feet MSL
     * @return {array}                   [success of operation, readback]
     */
    goAround(heading, speed, airportElevation) {
        const altitudeToMaintain = _ceil(airportElevation, -2) + 1000;

        this._mcp.setHeadingFieldValue(heading);
        this._mcp.setHeadingHold();
        this._mcp.setAltitudeFieldValue(altitudeToMaintain);
        this._mcp.setAltitudeHold();
        this._mcp.setSpeedFieldValue(speed);
        this._mcp.setSpeedHold();

        const readback = {};
        readback.log = `go around, fly present heading, maintain ${altitudeToMaintain}`;
        readback.say = `go around, fly present heading, maintain ${radio_altitude(altitudeToMaintain)}`;

        return [true, readback];
    }

    /**
     * Intercept a radial course or localizer (horizontal guidance)
     *
     * @for Pilot
     * @method _interceptCourse
     * @param datum {StaticPositionModel}  the position the course is based upon
     * @param course {number}              the heading inbound to the datum
     * @return {array}                     [success of operation, readback]
     * @private
     */
    _interceptCourse(datum, course) {
        this._mcp.setNav1Datum(datum);
        this._mcp.setCourseFieldValue(course);
        this._mcp.setHeadingVorLoc();

        const readback = {};
        readback.log = 'intercept localizer';
        readback.say = 'intercept localizer';

        return [true, readback];
    }

    /**
     * Intercept a glidepath or glideslop (vertical guidance)
     *
     * @for Pilot
     * @method _interceptGlidepath
     * @param datum {StaticPositionModel}  the position the glidepath is projected from
     * @param course {number}              the heading inbound to the datum
     * @param descentAngle {number}        the angle of descent along the glidepath
     * @param interceptAltitude {number}   the altitude to which the aircraft can descend without yet
     *                                     being established on the glidepath
     * @return {array}                     [success of operation, readback]
     * @private
     */
    _interceptGlidepath(datum, course, descentAngle, interceptAltitude) {
        // TODO: I feel like our description of lateral/vertical guidance should be done with its
        // own class rather than like this by storing all sorts of irrelevant stuff in the pilot/MCP.
        if (this._mcp.nav1Datum !== datum) {
            return [false, 'cannot follow glidepath because we are using lateral navigation from a different origin'];
        }

        if (this._mcp.course !== course) {
            return [
                false,
                'cannot follow glidepath because its course differs from that specified for lateral guidance'
            ];
        }

        // TODO: the descentAngle is a part of the ILS system itself, and should not be owned by the MCP
        this._mcp.setDescentAngle(descentAngle);
        this._mcp.setAltitudeFieldValue(interceptAltitude);
        this._mcp.setAltitudeApproach();

        const readback = {};
        readback.log = 'intercept glidepath';
        readback.log = 'intercept glidepath';

        return [true, readback];
    }

    /**
     * Conduct the specified instrument approachType
     * Note: Currently only supports ILS approaches
     * Note: Approach variants cannot yet be specified (eg RNAV-Y)
     *
     * @for pilot
     * @method conductInstrumentApproach
     * @param approachType {string}       the type of instrument approach (eg 'ILS', 'RNAV', 'VOR', etc)
     * @param runwayModel {RunwayModel}   the runway the approach ends at
     * @param interceptAltitude {number}  the altitude to maintain until established on the localizer
     * @param heading {number}            current aircraft heading (in radians)
     * @return {array}                    [success of operation, readback]
     */
    conductInstrumentApproach(approachType, runwayModel, interceptAltitude, heading) {
        if (_isNil(runwayModel)) {
            return [false, 'the specified runway does not exist'];
        }

        if (this._mcp.headingMode !== MCP_MODE.HEADING.HOLD) {
            this.maintainPresentHeading(heading);
        }

        // TODO: split these two method calls and the corresponding ifs to a new method
        const datum = runwayModel.positionModel;
        const course = runwayModel.angle;
        const descentAngle = runwayModel.ils.gs_gradient;
        const lateralGuidance = this._interceptCourse(datum, course);
        const verticalGuidance = this._interceptGlidepath(datum, course, descentAngle, interceptAltitude);

        // TODO: this may need to be implemented in the future. as written, `._interceptCourse()` will always
        // return true
        // if (!lateralGuidance[0]) {
        //     return lateralGuidance;
        // }

        if (!verticalGuidance[0]) {
            return verticalGuidance;
        }

        this._fms.exitHoldIfHolding();
        this._fms.setArrivalRunway(runwayModel);
        this.hasApproachClearance = true;

        const readback = {};
        readback.log = `cleared ${approachType.toUpperCase()} runway ${runwayModel.name} approach`;
        readback.say = `cleared ${approachType.toUpperCase()} runway ${radio_runway(runwayModel.name)} approach`;

        return [true, readback];
    }

    /**
     * Conduct a holding pattern at a specific Fix/Waypoint/Position
     *
     * @for Fms
     * @method initiateHoldingPattern
     * @param inboundHeading {number}
     * @param turnDirection {string}                     direction to turn once established in a holding pattern
     * @param legLength {string}                         in either `min` or `nm` length of each side of the
     *                                                   holding pattern.
     * @param fixName {string|null}                      name of the fix to hold at, only `null` if holding at
     *                                                   current position
     * @param holdPosition {StaticPositionModel}         StaticPositionModel of the position to hold over
     * @return {array} [success of operation, readback]
     */
    initiateHoldingPattern(
        inboundHeading,
        turnDirection,
        legLength,
        fixName = null,
        holdPosition = null
    ) {
        let holdRouteSegment = `@${fixName}`;
        const inboundDirection = getRadioCardinalDirectionNameForHeading(inboundHeading);
        let successMessage = `proceed direct ${fixName} and hold inbound, ${turnDirection} turns, ${legLength} legs`;

        if (!holdPosition) {
            return [false, `unable to find fix ${fixName}`];
        }

        if (!fixName) {
            holdRouteSegment = 'GPS';
            successMessage = `hold ${inboundDirection} of present position, ${turnDirection} turns, ${legLength} legs`;
        }

        // TODO: there are probably some `_mcp` updates that should happen here too.

        this._fms.createLegWithHoldingPattern(inboundHeading, turnDirection, legLength, holdRouteSegment, holdPosition);

        return [true, successMessage];
    }

    /**
     * Initialize all autopilot systems after being given an IFR clearance to destination
     *
     * @for Pilot
     * @method configureForTakeoff
     * @param initialAltitude {number} the altitude aircraft can automatically climb to at this airport
     * @param runway {RunwayModel} the runway taking off on
     * @param cruiseSpeed {number} the cruise speed of the aircraft, in knots
     */
    configureForTakeoff(initialAltitude, runway, cruiseSpeed) {
        if (this._mcp.altitude === -1) {
            this._mcp.setAltitudeFieldValue(initialAltitude);
        }

        if (this._mcp.altitudeMode === MCP_MODE.ALTITUDE.OFF) {
            this._mcp.setAltitudeHold();
        }

        if (this._mcp.heading === -1) {
            this._mcp.setHeadingFieldValue(runway.angle);
        }

        if (this._mcp.headingMode === MCP_MODE.HEADING.OFF) {
            this._mcp.setHeadingLnav();
        }

        if (this._mcp.speed === -1) {
            this._mcp.setSpeedFieldValue(cruiseSpeed);
        }

        if (this._mcp.speedMode === MCP_MODE.SPEED.OFF) {
            this._mcp.setSpeedN1();
        }
    }

    /**
     * Expedite the climb or descent to the assigned altitude, to use maximum possible rate
     *
     * @for Pilot
     * @method shouldExpediteAltitudeChange
     * @return {Array} [success of operation, readback]
     */
    shouldExpediteAltitudeChange() {
        this._mcp.shouldExpediteAltitudeChange = true;

        return [true, 'expediting to assigned altitude'];
    }

    /**
     * Skip ahead in the FMS to the waypoint for the specified waypointName, and activate LNAV to fly to it
     *
     * @for Pilot
     * @method proceedDirect
     * @param waypointName {string}  name of the fix we are flying direct to
     * @return {array}               [success of operation, readback]
     */
    proceedDirect(waypointName) {
        if (!this._fms.hasWaypoint(waypointName)) {
            return [false, `cannot proceed direct to ${waypointName}, it does not exist in our flight plan`];
        }

        this._fms.skipToWaypoint(waypointName);
        this._fms.exitHoldIfHolding();
        this._mcp.setHeadingLnav();

        return [true, `proceed direct ${waypointName}`];
    }

    /**
     * End of takeoff, stop hand flying, and give the autopilot control of the aircraft
     *
     * Note: This should be done when the phase changes from takeoff to climb
     * Note: The 'raise landing gear' portion has no relevance, and exists solely for specificity of context
     *
     * @for Pilot
     * @method raiseLandingGearAndActivateAutopilot
     */
    raiseLandingGearAndActivateAutopilot() {
        this._mcp.enable();
    }

    /**
     * Return the route of the aircraft
     *
     * @for AircraftCommander
     * @method sayRoute
     * @return {Array} [success of operation, readback]
     */
    sayRoute() {
        const readback = {};
        readback.log = `route: ${this._fms.currentRoute}`;
        readback.say = 'here\'s our route';

        return [true, readback];
    }

    /**
     * Return the altitude the aircraft is currently assigned. May be moving toward this altitude,
     * or already established at that altitude.
     *
     * @for Pilot
     * @method sayTargetedAltitude
     * @return {Array} [success of operation, readback]
     */
    sayTargetedAltitude() {
        const readback = {};
        readback.log = `we're assigned ${this._mcp.altitude}`;
        readback.say = `we're assigned ${radio_altitude(this._mcp.altitude)}`;

        return [true, readback];
    }

    /**
     * Return the heading the aircraft is currently targeting. May be moving toward this heading,
     * or already established at that heading.
     *
     * @for Pilot
     * @method sayTargetHeading
     * @return {array} [success of operation, readback]
     */
    sayTargetHeading() {
        const readback = {};

        switch (this._mcp.headingMode) {
            case MCP_MODE.HEADING.HOLD:
                readback.log = `we're assigned heading ${this._mcp.headingInDegrees}`;
                readback.say = `we're assigned heading ${radio_heading(this._mcp.headingInDegrees)}`;

                return [true, readback];

            case MCP_MODE.HEADING.VOR_LOC:
                readback.log = `we're joining a course of ${this._mcp.course}`;
                readback.say = `we're joining a course of ${radio_heading(this._mcp.course)}`;

                return [true, readback];

            case MCP_MODE.HEADING.LNAV: {
                // the currentWaypoint does not contain any heading information, that can only be calculated
                // from two waypoints.
                // TODO: this block needs some work.
                const heading = this._fms.currentWaypoint.heading;
                const fixName = this._fms.currentWaypoint.name;

                readback.log = `we're heading ${heading} toward ${fixName}`;
                readback.say = `we're heading ${radio_heading(heading)} toward ${fixName}`;

                return [true, readback];
            }

            default:
                readback.log = 'we haven\'t been assigned a heading';
                readback.say = 'we haven\'t been assigned a heading';

                return [true, readback];
        }
    }

    /**
     * Return the speed the aircraft is currently assigned. May be moving toward this speed, or
     * already established at this speed.
     *
     * @for Pilot
     * @method sayTargetedSpeed
     */
    sayTargetedSpeed() {
        if (this._mcp.speed === MCP_MODE.SPEED.VNAV) {
            // TODO: how do we handle the cases where there isn't a speedRestriction for a waypoint?
            return [true, this._fms.currentWaypoint.speed];
        }

        return [true, this._mcp.speed];
    }

    /**
     * Stop taxiing to the runway and return to the gate
     *
     * @for Pilot
     * @method stopOutboundTaxiAndReturnToGate
     * @return {Array} [success of operation, readback]
     */
    stopOutboundTaxiAndReturnToGate() {
        this._fms.flightPhase = FLIGHT_PHASE.APRON;
        // TODO: What to do with this little number....?
        // aircraft.taxi_start = 0;

        return [true, 'taxiing back to the gate'];
    }

    /**
     * Leave the departure line and return to the gate
     *
     * @for Pilot
     * @method stopWaitingInRunwayQueueAndReturnToGate
     * @return {Array} [success of operation, readback]
     */
    stopWaitingInRunwayQueueAndReturnToGate() {
        // TODO: this will likely need to be called from somewhere other than the `AircraftCommander`
        // TODO: remove aircraft from the runway queue (`Runway.removeAircraftFromQueue()`)
        this._fms.flightPhase = FLIGHT_PHASE.APRON;

        return [true, 'taxiing back to the gate'];
    }

    /**
     * Taxi the aircraft
     *
     * @for Pilot
     * @method taxiToRunway
     * @param taxiDestination {RunwayModel}  runway has already been verified by the
     *                                       time it is sent to this method
     * @param isDeparture {boolean}         whether the aircraft's flightPhase is DEPARTURE
     * @param flightPhase {string}          the flight phase of the aircraft
     * @return {array}                      [success of operation, readback]
     */
    taxiToRunway(taxiDestination, isDeparture, flightPhase) {
        if (flightPhase === FLIGHT_PHASE.TAXI) {
            return [false, 'already taxiing'];
        }

        if (flightPhase === FLIGHT_PHASE.WAITING) {
            return [false, 'already taxiied and waiting in runway queue'];
        }

        if (!isDeparture || flightPhase !== FLIGHT_PHASE.APRON) {
            return [false, 'unable to taxi'];
        }

        this._fms.setDepartureRunway(taxiDestination);

        const readback = {};
        readback.log = `taxi to runway ${taxiDestination.name}`;
        readback.say = `taxi to runway ${radio_runway(taxiDestination.name)}`;

        return [true, readback];
    }
}
