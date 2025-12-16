#ifndef GTFS_H
#define GTFS_H

#include <string>
#include <vector>
#include <map>
#include <unordered_map>
#include <memory>
#include <iostream>
#include <algorithm>
#include <shared_mutex>
#include <mutex>
#include <optional>

namespace gtfs {

// String Pool for memory optimization
class StringPool {
    std::unordered_map<std::string, uint32_t> str_to_id;
    std::vector<std::string> id_to_str;
    mutable std::shared_mutex mutex_;
public:
    void clear() {
        std::unique_lock<std::shared_mutex> lock(mutex_);
        str_to_id.clear();
        id_to_str.clear();
    }

    uint32_t intern(const std::string& s) {
        {
            std::shared_lock<std::shared_mutex> lock(mutex_);
            if (str_to_id.count(s)) return str_to_id.at(s);
        }
        std::unique_lock<std::shared_mutex> lock(mutex_);
        if (str_to_id.count(s)) return str_to_id.at(s);

        uint32_t id = static_cast<uint32_t>(id_to_str.size());
        str_to_id[s] = id;
        id_to_str.push_back(s);
        return id;
    }

    std::string get(uint32_t id) const {
        std::shared_lock<std::shared_mutex> lock(mutex_);
        if (id < id_to_str.size()) return id_to_str[id];
        return "";
    }
    
    // Check if string exists without creating it
    bool exists(const std::string& s) const {
        std::shared_lock<std::shared_mutex> lock(mutex_);
        return str_to_id.count(s);
    }
    
    uint32_t get_id(const std::string& s) const {
        std::shared_lock<std::shared_mutex> lock(mutex_);
        if (str_to_id.count(s)) return str_to_id.at(s);
        return 0xFFFFFFFF; // Sentinel for not found
    }
};

struct Agency {
    std::optional<std::string> agency_id = std::nullopt;
    std::string agency_name;
    std::string agency_url;
    std::string agency_timezone;
    std::optional<std::string> agency_lang = std::nullopt;
    std::optional<std::string> agency_phone = std::nullopt;
    std::optional<std::string> agency_fare_url = std::nullopt;
    std::optional<std::string> agency_email = std::nullopt;
};

struct Calendar {
    std::string service_id;
    bool monday;
    bool tuesday;
    bool wednesday;
    bool thursday;
    bool friday;
    bool saturday;
    bool sunday;
    std::string start_date; // YYYYMMDD
    std::string end_date;   // YYYYMMDD
};

struct CalendarDate {
    std::string service_id;
    std::string date;       // YYYYMMDD
    int exception_type;
};

struct Route {
    std::string route_id;
    std::optional<std::string> agency_id = std::nullopt;
    std::optional<std::string> route_short_name = std::nullopt;
    std::optional<std::string> route_long_name = std::nullopt;
    std::optional<std::string> route_desc = std::nullopt;
    int route_type;
    std::optional<std::string> route_url = std::nullopt;
    std::optional<std::string> route_color = std::nullopt;
    std::optional<std::string> route_text_color = std::nullopt;
    std::optional<int> continuous_pickup = std::nullopt;
    std::optional<int> continuous_drop_off = std::nullopt;
    std::optional<int> route_sort_order = std::nullopt;
    std::optional<std::string> network_id = std::nullopt;
};

struct Stop {
    std::string stop_id;
    std::optional<std::string> stop_code = std::nullopt;
    std::string stop_name;
    std::optional<std::string> stop_desc = std::nullopt;
    std::optional<double> stop_lat = std::nullopt;
    std::optional<double> stop_lon = std::nullopt;
    std::optional<std::string> zone_id = std::nullopt;
    std::optional<std::string> stop_url = std::nullopt;
    std::optional<int> location_type = std::nullopt;
    std::optional<std::string> parent_station = std::nullopt;
    std::optional<std::string> stop_timezone = std::nullopt;
    std::optional<int> wheelchair_boarding = std::nullopt;
    std::optional<std::string> level_id = std::nullopt;
    std::optional<std::string> platform_code = std::nullopt;
    std::optional<std::string> tts_stop_name = std::nullopt;
};

struct StopTime {
    uint32_t trip_id;       // Interned ID
    std::optional<int> arrival_time;       // Seconds since midnight
    std::optional<int> departure_time;     // Seconds since midnight
    uint32_t stop_id;       // Interned ID
    int stop_sequence;
    std::optional<uint32_t> stop_headsign; // Interned ID
    int pickup_type;
    int drop_off_type;
    std::optional<double> shape_dist_traveled = std::nullopt;
    std::optional<int> timepoint = std::nullopt;
    std::optional<int> continuous_pickup = std::nullopt;
    std::optional<int> continuous_drop_off = std::nullopt;
};

struct Trip {
    std::string route_id;
    std::string service_id;
    std::string trip_id;
    std::optional<std::string> trip_headsign = std::nullopt;
    std::optional<std::string> trip_short_name = std::nullopt;
    std::optional<int> direction_id = std::nullopt;
    std::optional<std::string> block_id = std::nullopt;
    std::optional<std::string> shape_id = std::nullopt;
    std::optional<int> wheelchair_accessible = std::nullopt;
    std::optional<int> bikes_allowed = std::nullopt;
};

struct Shape {
    std::string shape_id;
    double shape_pt_lat;
    double shape_pt_lon;
    int shape_pt_sequence;
    std::optional<double> shape_dist_traveled = std::nullopt;
};

struct FeedInfo {
    std::string feed_publisher_name;
    std::string feed_publisher_url;
    std::string feed_lang;
    std::optional<std::string> default_lang = std::nullopt;
    std::optional<std::string> feed_start_date = std::nullopt;
    std::optional<std::string> feed_end_date = std::nullopt;
    std::optional<std::string> feed_version = std::nullopt;
    std::optional<std::string> feed_contact_email = std::nullopt;
    std::optional<std::string> feed_contact_url = std::nullopt;
};

// Realtime Structures
struct RealtimeTripDescriptor {
    std::string trip_id;
    std::string route_id;
    int direction_id = -1;
    std::string start_time;
    std::string start_date;
    int schedule_relationship = 0;
};

struct RealtimeVehicleDescriptor {
    std::string id;
    std::string label;
    std::string license_plate;
};

struct RealtimeStopTimeUpdate {
    int stop_sequence = -1;
    std::string stop_id;
    std::string trip_id;
    std::string start_date; // Reflect start_date from trip update
    std::string start_time; // Reflect start_time from trip update
    int arrival_delay = -2147483648;
    int64_t arrival_time = -1;
    int arrival_uncertainty = -1;

    int departure_delay = -2147483648;
    int64_t departure_time = -1;
    int departure_uncertainty = -1;

    int schedule_relationship = 0;
};

struct RealtimeTripUpdate {
    std::string update_id;
    bool is_deleted = false;
    RealtimeTripDescriptor trip;
    RealtimeVehicleDescriptor vehicle;
    std::vector<RealtimeStopTimeUpdate> stop_time_updates;
    uint64_t timestamp = 0;
    int delay = -2147483648;
};

struct RealtimePosition {
    float latitude = 0.0f;
    float longitude = 0.0f;
    float bearing = -1.0f;
    double odometer = -1.0;
    float speed = -1.0f;
};

struct RealtimeVehiclePosition {
    std::string update_id;
    bool is_deleted = false;
    RealtimeTripDescriptor trip;
    RealtimeVehicleDescriptor vehicle;
    RealtimePosition position;
    int current_stop_sequence = -1;
    std::string stop_id;
    int current_status = -1;
    uint64_t timestamp = 0;
    int congestion_level = -1;
    int occupancy_status = -1;
    int occupancy_percentage = -1;
};

struct RealtimeAlert {
    std::string update_id;
    bool is_deleted = false;
    std::vector<std::string> active_period_start;
    std::vector<std::string> active_period_end;
    // Simplified for now, complex to map all EntitySelectors
    int cause = -1;
    int effect = -1;
    std::string url;
    std::string header_text;
    std::string description_text;
    int severity_level = -1;
};

class GTFSData {
public:
    StringPool string_pool;

    // Realtime Data Containers
    std::vector<RealtimeTripUpdate> realtime_trip_updates;
    std::vector<RealtimeVehiclePosition> realtime_vehicle_positions;
    std::vector<RealtimeAlert> realtime_alerts;

    std::unordered_map<std::string, Agency> agencies;
    std::unordered_map<std::string, Calendar> calendars;
    std::unordered_map<std::string, std::unordered_map<std::string, int>> calendar_dates; 
    std::unordered_map<std::string, Route> routes;
    std::unordered_map<std::string, Stop> stops;
    
    std::vector<StopTime> stop_times; 

    std::unordered_map<uint32_t, std::vector<size_t>> stop_times_by_stop_id;

    std::unordered_map<std::string, Trip> trips;
    std::vector<Shape> shapes;
    std::vector<FeedInfo> feed_info;

    void clear() {
        string_pool.clear();
        agencies.clear();
        calendars.clear();
        calendar_dates.clear();
        routes.clear();
        stops.clear();
        stop_times.clear();
        stop_times_by_stop_id.clear();
        trips.clear();
        shapes.clear();
        feed_info.clear();

        realtime_trip_updates.clear();
        realtime_vehicle_positions.clear();
        realtime_alerts.clear();
    }
};

} // namespace gtfs

#endif
