// Enums
export var RouteType;
(function (RouteType) {
    RouteType[RouteType["Tram"] = 0] = "Tram";
    RouteType[RouteType["Subway"] = 1] = "Subway";
    RouteType[RouteType["Rail"] = 2] = "Rail";
    RouteType[RouteType["Bus"] = 3] = "Bus";
    RouteType[RouteType["Ferry"] = 4] = "Ferry";
    RouteType[RouteType["CableTram"] = 5] = "CableTram";
    RouteType[RouteType["AerialLift"] = 6] = "AerialLift";
    RouteType[RouteType["Funicular"] = 7] = "Funicular";
    RouteType[RouteType["Trolleybus"] = 11] = "Trolleybus";
    RouteType[RouteType["Monorail"] = 12] = "Monorail";
})(RouteType || (RouteType = {}));
export var LocationType;
(function (LocationType) {
    LocationType[LocationType["Stop"] = 0] = "Stop";
    LocationType[LocationType["Station"] = 1] = "Station";
    LocationType[LocationType["EntranceExit"] = 2] = "EntranceExit";
    LocationType[LocationType["GenericNode"] = 3] = "GenericNode";
    LocationType[LocationType["BoardingArea"] = 4] = "BoardingArea";
})(LocationType || (LocationType = {}));
export var WheelchairBoarding;
(function (WheelchairBoarding) {
    WheelchairBoarding[WheelchairBoarding["NoInfo"] = 0] = "NoInfo";
    WheelchairBoarding[WheelchairBoarding["Accessible"] = 1] = "Accessible";
    WheelchairBoarding[WheelchairBoarding["NotAccessible"] = 2] = "NotAccessible";
})(WheelchairBoarding || (WheelchairBoarding = {}));
export var PickupType;
(function (PickupType) {
    PickupType[PickupType["Regular"] = 0] = "Regular";
    PickupType[PickupType["None"] = 1] = "None";
    PickupType[PickupType["Phone"] = 2] = "Phone";
    PickupType[PickupType["Driver"] = 3] = "Driver";
})(PickupType || (PickupType = {}));
export var DropOffType;
(function (DropOffType) {
    DropOffType[DropOffType["Regular"] = 0] = "Regular";
    DropOffType[DropOffType["None"] = 1] = "None";
    DropOffType[DropOffType["Phone"] = 2] = "Phone";
    DropOffType[DropOffType["Driver"] = 3] = "Driver";
})(DropOffType || (DropOffType = {}));
export var ContinuousPickup;
(function (ContinuousPickup) {
    ContinuousPickup[ContinuousPickup["Continuous"] = 0] = "Continuous";
    ContinuousPickup[ContinuousPickup["None"] = 1] = "None";
    ContinuousPickup[ContinuousPickup["Phone"] = 2] = "Phone";
    ContinuousPickup[ContinuousPickup["Driver"] = 3] = "Driver";
})(ContinuousPickup || (ContinuousPickup = {}));
export var ContinuousDropOff;
(function (ContinuousDropOff) {
    ContinuousDropOff[ContinuousDropOff["Continuous"] = 0] = "Continuous";
    ContinuousDropOff[ContinuousDropOff["None"] = 1] = "None";
    ContinuousDropOff[ContinuousDropOff["Phone"] = 2] = "Phone";
    ContinuousDropOff[ContinuousDropOff["Driver"] = 3] = "Driver";
})(ContinuousDropOff || (ContinuousDropOff = {}));
export var WheelchairAccessible;
(function (WheelchairAccessible) {
    WheelchairAccessible[WheelchairAccessible["NoInfo"] = 0] = "NoInfo";
    WheelchairAccessible[WheelchairAccessible["Accessible"] = 1] = "Accessible";
    WheelchairAccessible[WheelchairAccessible["NotAccessible"] = 2] = "NotAccessible";
})(WheelchairAccessible || (WheelchairAccessible = {}));
export var BikesAllowed;
(function (BikesAllowed) {
    BikesAllowed[BikesAllowed["NoInfo"] = 0] = "NoInfo";
    BikesAllowed[BikesAllowed["Allowed"] = 1] = "Allowed";
    BikesAllowed[BikesAllowed["NotAllowed"] = 2] = "NotAllowed";
})(BikesAllowed || (BikesAllowed = {}));
// Realtime Enums
export var TripScheduleRelationship;
(function (TripScheduleRelationship) {
    TripScheduleRelationship[TripScheduleRelationship["SCHEDULED"] = 0] = "SCHEDULED";
    TripScheduleRelationship[TripScheduleRelationship["ADDED"] = 1] = "ADDED";
    TripScheduleRelationship[TripScheduleRelationship["UNSCHEDULED"] = 2] = "UNSCHEDULED";
    TripScheduleRelationship[TripScheduleRelationship["CANCELED"] = 3] = "CANCELED";
    TripScheduleRelationship[TripScheduleRelationship["REPLACEMENT"] = 5] = "REPLACEMENT";
})(TripScheduleRelationship || (TripScheduleRelationship = {}));
export var StopTimeScheduleRelationship;
(function (StopTimeScheduleRelationship) {
    StopTimeScheduleRelationship[StopTimeScheduleRelationship["SCHEDULED"] = 0] = "SCHEDULED";
    StopTimeScheduleRelationship[StopTimeScheduleRelationship["SKIPPED"] = 1] = "SKIPPED";
    StopTimeScheduleRelationship[StopTimeScheduleRelationship["NO_DATA"] = 2] = "NO_DATA";
    StopTimeScheduleRelationship[StopTimeScheduleRelationship["UNSCHEDULED"] = 3] = "UNSCHEDULED";
})(StopTimeScheduleRelationship || (StopTimeScheduleRelationship = {}));
export var VehicleStopStatus;
(function (VehicleStopStatus) {
    VehicleStopStatus[VehicleStopStatus["INCOMING_AT"] = 0] = "INCOMING_AT";
    VehicleStopStatus[VehicleStopStatus["STOPPED_AT"] = 1] = "STOPPED_AT";
    VehicleStopStatus[VehicleStopStatus["IN_TRANSIT_TO"] = 2] = "IN_TRANSIT_TO";
})(VehicleStopStatus || (VehicleStopStatus = {}));
export var CongestionLevel;
(function (CongestionLevel) {
    CongestionLevel[CongestionLevel["UNKNOWN_CONGESTION_LEVEL"] = 0] = "UNKNOWN_CONGESTION_LEVEL";
    CongestionLevel[CongestionLevel["RUNNING_SMOOTHLY"] = 1] = "RUNNING_SMOOTHLY";
    CongestionLevel[CongestionLevel["STOP_AND_GO"] = 2] = "STOP_AND_GO";
    CongestionLevel[CongestionLevel["CONGESTION"] = 3] = "CONGESTION";
    CongestionLevel[CongestionLevel["SEVERE_CONGESTION"] = 4] = "SEVERE_CONGESTION";
})(CongestionLevel || (CongestionLevel = {}));
export var OccupancyStatus;
(function (OccupancyStatus) {
    OccupancyStatus[OccupancyStatus["EMPTY"] = 0] = "EMPTY";
    OccupancyStatus[OccupancyStatus["MANY_SEATS_AVAILABLE"] = 1] = "MANY_SEATS_AVAILABLE";
    OccupancyStatus[OccupancyStatus["FEW_SEATS_AVAILABLE"] = 2] = "FEW_SEATS_AVAILABLE";
    OccupancyStatus[OccupancyStatus["STANDING_ROOM_ONLY"] = 3] = "STANDING_ROOM_ONLY";
    OccupancyStatus[OccupancyStatus["CRUSHED_STANDING_ROOM_ONLY"] = 4] = "CRUSHED_STANDING_ROOM_ONLY";
    OccupancyStatus[OccupancyStatus["FULL"] = 5] = "FULL";
    OccupancyStatus[OccupancyStatus["NOT_ACCEPTING_PASSENGERS"] = 6] = "NOT_ACCEPTING_PASSENGERS";
})(OccupancyStatus || (OccupancyStatus = {}));
export var AlertCause;
(function (AlertCause) {
    AlertCause[AlertCause["UNKNOWN_CAUSE"] = 1] = "UNKNOWN_CAUSE";
    AlertCause[AlertCause["OTHER_CAUSE"] = 2] = "OTHER_CAUSE";
    AlertCause[AlertCause["TECHNICAL_PROBLEM"] = 3] = "TECHNICAL_PROBLEM";
    AlertCause[AlertCause["STRIKE"] = 4] = "STRIKE";
    AlertCause[AlertCause["DEMONSTRATION"] = 5] = "DEMONSTRATION";
    AlertCause[AlertCause["ACCIDENT"] = 6] = "ACCIDENT";
    AlertCause[AlertCause["HOLIDAY"] = 7] = "HOLIDAY";
    AlertCause[AlertCause["WEATHER"] = 8] = "WEATHER";
    AlertCause[AlertCause["MAINTENANCE"] = 9] = "MAINTENANCE";
    AlertCause[AlertCause["CONSTRUCTION"] = 10] = "CONSTRUCTION";
    AlertCause[AlertCause["POLICE_ACTIVITY"] = 11] = "POLICE_ACTIVITY";
    AlertCause[AlertCause["MEDICAL_EMERGENCY"] = 12] = "MEDICAL_EMERGENCY";
})(AlertCause || (AlertCause = {}));
export var AlertEffect;
(function (AlertEffect) {
    AlertEffect[AlertEffect["NO_SERVICE"] = 1] = "NO_SERVICE";
    AlertEffect[AlertEffect["REDUCED_SERVICE"] = 2] = "REDUCED_SERVICE";
    AlertEffect[AlertEffect["SIGNIFICANT_DELAYS"] = 3] = "SIGNIFICANT_DELAYS";
    AlertEffect[AlertEffect["DETOUR"] = 4] = "DETOUR";
    AlertEffect[AlertEffect["ADDITIONAL_SERVICE"] = 5] = "ADDITIONAL_SERVICE";
    AlertEffect[AlertEffect["MODIFIED_SERVICE"] = 6] = "MODIFIED_SERVICE";
    AlertEffect[AlertEffect["OTHER_EFFECT"] = 7] = "OTHER_EFFECT";
    AlertEffect[AlertEffect["UNKNOWN_EFFECT"] = 8] = "UNKNOWN_EFFECT";
    AlertEffect[AlertEffect["STOP_MOVED"] = 9] = "STOP_MOVED";
    AlertEffect[AlertEffect["NO_EFFECT"] = 10] = "NO_EFFECT";
    AlertEffect[AlertEffect["ACCESSIBILITY_ISSUE"] = 11] = "ACCESSIBILITY_ISSUE";
})(AlertEffect || (AlertEffect = {}));
export var AlertSeverityLevel;
(function (AlertSeverityLevel) {
    AlertSeverityLevel[AlertSeverityLevel["UNKNOWN_SEVERITY"] = 1] = "UNKNOWN_SEVERITY";
    AlertSeverityLevel[AlertSeverityLevel["INFO"] = 2] = "INFO";
    AlertSeverityLevel[AlertSeverityLevel["WARNING"] = 3] = "WARNING";
    AlertSeverityLevel[AlertSeverityLevel["SEVERE"] = 4] = "SEVERE";
})(AlertSeverityLevel || (AlertSeverityLevel = {}));
