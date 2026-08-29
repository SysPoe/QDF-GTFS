#ifndef GTFS_H
#define GTFS_H

#include <string>
#include <string_view>
#include <vector>
#include <map>
#include <unordered_map>
#include <memory>
#include <iostream>
#include <algorithm>
#include <shared_mutex>
#include <mutex>
#include <utility>
#include <optional>
#include <cstddef>
#include <cstdint>
#include <climits>
#include <limits>
#include <stdexcept>


namespace gtfs {

// Sentinel constants for StopTime fields
constexpr int32_t  ST_NO_TIME    = INT32_MIN;
constexpr uint32_t ST_NO_HEADSIGN = 0xFFFFFFFFu;
constexpr double   ST_NO_DIST    = -1.0;
constexpr int8_t   ST_NO_INT8    = -1;
constexpr double   SHAPE_NO_DIST = std::numeric_limits<double>::quiet_NaN();

struct BufferView {
    const unsigned char* data;
    size_t size;
};

// Transparent hash for heterogeneous string lookups (C++20)
struct TransparentStringHash {
    using is_transparent = void;
    size_t operator()(std::string_view sv) const noexcept {
        return std::hash<std::string_view>{}(sv);
    }
};

class StringPool {
    std::unordered_map<std::string, uint32_t, TransparentStringHash, std::equal_to<>> str_to_id;
    std::vector<std::string> id_to_str;
    mutable std::shared_mutex mutex_;
public:
    void clear() {
        std::unique_lock<std::shared_mutex> lock(mutex_);
        str_to_id.clear();
        id_to_str.clear();
    }

    void release() {
		clear();
		std::unique_lock<std::shared_mutex> lock(mutex_);
		str_to_id.rehash(0);
		id_to_str.shrink_to_fit();
	}

    std::vector<std::string> snapshotStrings() const {
        std::shared_lock<std::shared_mutex> lock(mutex_);
        return id_to_str;
    }

    void restoreStrings(const std::vector<std::string>& vec) {
        std::unique_lock<std::shared_mutex> lock(mutex_);
        id_to_str = vec;
        str_to_id.clear();
        str_to_id.reserve(vec.size()*2);
        for (uint32_t i=0;i<vec.size();++i) str_to_id.emplace(vec[i], i);
    }

    // Heterogeneous intern: avoids allocation if already interned
    uint32_t intern(std::string_view sv) {
        {
            std::shared_lock<std::shared_mutex> lock(mutex_);
            auto it = str_to_id.find(sv);
            if (it != str_to_id.end()) return it->second;
        }
        std::unique_lock<std::shared_mutex> lock(mutex_);
        auto it = str_to_id.find(sv);
        if (it != str_to_id.end()) return it->second;

        uint32_t id = static_cast<uint32_t>(id_to_str.size());
        str_to_id.emplace(std::string(sv), id);
        id_to_str.emplace_back(sv);
        return id;
    }

    uint32_t intern(const char* s, size_t len) {
        return intern(std::string_view(s, len));
    }

    uint32_t intern(const std::string& s) {
        return intern(std::string_view(s));
    }

    std::string get(uint32_t id) const {
        std::shared_lock<std::shared_mutex> lock(mutex_);
        if (id < id_to_str.size()) return id_to_str[id];
        return "";
    }

    // GTFS query methods are synchronous and run only after loading completes.
    // This avoids allocating a temporary std::string for every returned row.
    const std::string& get_ref(uint32_t id) const {
        static const std::string empty;
        if (id < id_to_str.size()) return id_to_str[id];
        return empty;
    }

    bool exists(std::string_view sv) const {
        std::shared_lock<std::shared_mutex> lock(mutex_);
        return str_to_id.count(sv) > 0;
    }

    bool exists(const std::string& s) const {
        return exists(std::string_view(s));
    }

    uint32_t get_id(std::string_view sv) const {
        std::shared_lock<std::shared_mutex> lock(mutex_);
        auto it = str_to_id.find(sv);
        if (it != str_to_id.end()) return it->second;
        return 0xFFFFFFFF;
    }

    uint32_t get_id(const std::string& s) const {
        return get_id(std::string_view(s));
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
    std::string feed_id;
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
    std::string start_date;
    std::string end_date;
    std::string feed_id;
};

struct CalendarDate {
    std::string service_id;
    std::string date;
    int exception_type;
    std::string feed_id;
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
    std::string feed_id;
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
    std::string feed_id;
};

// Compact StopTime: sentinel values replace std::optional (~48 bytes vs ~88 bytes)
struct StopTime {
    uint32_t trip_id          = 0;
    int32_t  arrival_time     = ST_NO_TIME;     // sentinel: INT32_MIN
    int32_t  departure_time   = ST_NO_TIME;     // sentinel: INT32_MIN
    uint32_t stop_id          = 0;
    int32_t  stop_sequence    = 0;
    uint32_t stop_headsign    = ST_NO_HEADSIGN; // sentinel: 0xFFFFFFFF
    double   shape_dist_traveled = ST_NO_DIST;  // sentinel: -1.0
    uint32_t feed_id          = 0;
    int8_t   pickup_type      = 0;
    int8_t   drop_off_type    = 0;
    int8_t   timepoint        = ST_NO_INT8;     // sentinel: -1
    int8_t   continuous_pickup  = ST_NO_INT8;   // sentinel: -1
    int8_t   continuous_drop_off = ST_NO_INT8;  // sentinel: -1
    uint8_t  _pad[3]          = {};
};

// TfNSW static extension from occupancies.txt. Dates are YYYYMMDD integers;
// end_date 0 means the rule has no explicit upper bound.
struct StaticOccupancy {
    uint32_t trip_id = 0;
    uint32_t feed_id = 0;
    uint32_t start_date = 0;
    uint32_t end_date = 0;
    int32_t stop_sequence = 0;
    int8_t occupancy_status = -1;
    uint8_t weekday_mask = 0;
    int8_t exception = 0;
    uint8_t _pad = 0;
};

static_assert(sizeof(StaticOccupancy) <= 24, "Static occupancy storage must remain compact");

struct Trip {
    uint32_t route_id = 0;
    uint32_t service_id = 0;
    uint32_t trip_id = 0;
    uint32_t trip_headsign = ST_NO_HEADSIGN;
    uint32_t trip_short_name = ST_NO_HEADSIGN;
    uint32_t block_id = ST_NO_HEADSIGN;
    uint32_t shape_id = ST_NO_HEADSIGN;
    uint32_t feed_id = 0;
    int32_t direction_id = ST_NO_TIME;
    int32_t wheelchair_accessible = ST_NO_TIME;
    int32_t bikes_allowed = ST_NO_TIME;
};

static_assert(sizeof(Trip) <= 48, "Trip storage must remain compact");

struct Transfer {
    std::optional<std::string> from_stop_id = std::nullopt;
    std::optional<std::string> to_stop_id = std::nullopt;
    std::optional<std::string> from_route_id = std::nullopt;
    std::optional<std::string> to_route_id = std::nullopt;
    std::optional<std::string> from_trip_id = std::nullopt;
    std::optional<std::string> to_trip_id = std::nullopt;
    int transfer_type = 0;
    std::optional<int> min_transfer_time = std::nullopt;
    std::string feed_id;
};

struct Shape {
    double shape_pt_lat;
    double shape_pt_lon;
    double shape_dist_traveled = SHAPE_NO_DIST;
    uint32_t shape_id;
    uint32_t feed_id;
    int32_t shape_pt_sequence;
};

static_assert(sizeof(Shape) <= 40, "Shape storage must remain compact");

struct IndexRange {
    uint32_t begin = 0;
    uint32_t count = 0;
};

static_assert(sizeof(IndexRange) == 8, "Index ranges must stay compact");

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
    std::string feed_id;
};

struct RealtimeTripDescriptor {
    std::string trip_id;
    std::string route_id;
    int direction_id = -1;
    std::string start_time;
    std::string start_date;
    int schedule_relationship = 0;
    std::string feed_id;
};

struct RealtimeVehicleDescriptor {
    std::string id;
    std::string label;
    std::string license_plate;
};

struct RealtimeCarriageDetails {
    std::string id;
    std::string label;
    int occupancy_status = -1;
    int occupancy_percentage = -1;
    int carriage_sequence = -1;
};

struct RealtimeChangedTrip {
    std::string trip_id;
    std::string feed_id;
};

struct RealtimeParseResult {
    std::vector<RealtimeChangedTrip> changed_trip_ids;
    size_t trip_update_count = 0;
    size_t stop_time_update_count = 0;
    size_t vehicle_count = 0;
};

struct RealtimeStopTimeUpdate {
    int stop_sequence = -1;
    std::string stop_id;
    std::string trip_id;
    std::string start_date;
    std::string start_time;
    int arrival_delay = -2147483648;
    int64_t arrival_time = -1;
    int arrival_uncertainty = -1;

    int departure_delay = -2147483648;
    int64_t departure_time = -1;
    int departure_uncertainty = -1;

    int schedule_relationship = 0;
    std::string feed_id;
    std::string source_id;
};

struct RealtimeTripUpdate {
    std::string update_id;
    bool is_deleted = false;
    RealtimeTripDescriptor trip;
    RealtimeVehicleDescriptor vehicle;
    std::vector<RealtimeStopTimeUpdate> stop_time_updates;
    uint64_t timestamp = 0;
    int delay = -2147483648;
    std::string feed_id;
    std::string source_id;
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
    std::vector<RealtimeCarriageDetails> multi_carriage_details;
    std::string feed_id;
    std::string source_id;
};

struct RealtimeAlert {
    std::string update_id;
    bool is_deleted = false;
    std::vector<std::string> active_period_start;
    std::vector<std::string> active_period_end;
    int cause = -1;
    int effect = -1;
    std::string url;
    std::string header_text;
    std::string description_text;
    int severity_level = -1;
    std::string feed_id;
    std::string source_id;
};

class GTFSData {
public:
    StringPool string_pool;

    std::vector<RealtimeTripUpdate> realtime_trip_updates;
    std::vector<RealtimeVehiclePosition> realtime_vehicle_positions;
    std::vector<RealtimeAlert> realtime_alerts;
    uint64_t realtime_revision = 0;

    // Vector positions keep the existing storage and retrieval order stable.
    // They are rebuilt after an erase because vector compaction shifts rows.
    std::unordered_map<std::string, std::vector<size_t>> realtime_trip_updates_by_trip_id;
    std::unordered_map<std::string, std::vector<size_t>> realtime_trip_updates_by_source_id;
    std::unordered_map<std::string, std::vector<size_t>> realtime_vehicle_positions_by_trip_id;
    std::unordered_map<std::string, std::vector<size_t>> realtime_vehicle_positions_by_source_id;
    std::unordered_map<std::string, std::vector<size_t>> realtime_alerts_by_source_id;

    std::unordered_map<std::string, std::unordered_map<std::string, Agency>> agencies;
    std::unordered_map<std::string, std::unordered_map<std::string, Calendar>> calendars;
    std::unordered_map<std::string, std::unordered_map<std::string, std::unordered_map<std::string, int>>> calendar_dates; // feed_id -> service_id -> date -> exception_type
    std::unordered_map<std::string, std::unordered_map<std::string, Route>> routes;
    std::unordered_map<std::string, std::unordered_map<std::string, Stop>> stops;

    std::vector<StopTime> stop_times; // Flat list, sorted by trip_id, stop_sequence

    // Stop postings share one compact array instead of allocating one
    // size_t vector per stop. Each map value addresses a slice of that array.
    std::unordered_map<uint32_t, IndexRange> stop_times_by_stop_id;
    std::vector<uint32_t> stop_time_indices_by_stop_id;
    // Rows are contiguous for a feed-qualified trip. A bare trip_id can occur
    // in several feeds, so its index can contain more than one range.
    std::unordered_map<uint32_t, std::vector<IndexRange>> stop_times_by_trip_id;

    std::vector<StaticOccupancy> static_occupancies;
    std::unordered_map<uint32_t, std::vector<size_t>> static_occupancies_by_trip_id;

    std::unordered_map<uint32_t, std::unordered_map<uint32_t, Trip>> trips;
    std::vector<Transfer> transfers;
    // Secondary indexes keep common trip searches out of the full feed map.
    // Pointers are stable because unordered_map stores trips in node objects.
    std::unordered_map<uint32_t, std::unordered_map<uint32_t, std::vector<const Trip*>>> trips_by_route_id;
    std::unordered_map<uint32_t, std::unordered_map<uint32_t, std::vector<const Trip*>>> trips_by_service_id;
    std::unordered_map<uint32_t, std::unordered_map<uint32_t, std::vector<const Trip*>>> trips_by_block_id;
    std::vector<Shape> shapes;
    // Each range is one feed-qualified shape. A bare shape_id can therefore
    // resolve to several ranges without scanning the full shape array.
    std::unordered_map<uint32_t, std::vector<std::pair<size_t, size_t>>> shape_ranges_by_id;
    std::vector<FeedInfo> feed_info;

    void clearRealtimeIndexes() {
        realtime_trip_updates_by_trip_id.clear();
        realtime_trip_updates_by_source_id.clear();
        realtime_vehicle_positions_by_trip_id.clear();
        realtime_vehicle_positions_by_source_id.clear();
        realtime_alerts_by_source_id.clear();
    }

    void indexRealtimeTripUpdate(size_t index) {
        const auto& update = realtime_trip_updates[index];
        realtime_trip_updates_by_trip_id[update.trip.trip_id].push_back(index);
        realtime_trip_updates_by_source_id[update.source_id].push_back(index);
    }

    void indexRealtimeVehiclePosition(size_t index) {
        const auto& position = realtime_vehicle_positions[index];
        realtime_vehicle_positions_by_trip_id[position.trip.trip_id].push_back(index);
        realtime_vehicle_positions_by_source_id[position.source_id].push_back(index);
    }

    void indexRealtimeAlert(size_t index) {
        realtime_alerts_by_source_id[realtime_alerts[index].source_id].push_back(index);
    }

    void rebuildRealtimeIndexes() {
        clearRealtimeIndexes();
        for (size_t index = 0; index < realtime_trip_updates.size(); ++index) {
            indexRealtimeTripUpdate(index);
        }
        for (size_t index = 0; index < realtime_vehicle_positions.size(); ++index) {
            indexRealtimeVehiclePosition(index);
        }
        for (size_t index = 0; index < realtime_alerts.size(); ++index) {
            indexRealtimeAlert(index);
        }
    }

    void rebuildStopTimeIndexes() {
        if (stop_times.size() > std::numeric_limits<uint32_t>::max()) {
            throw std::runtime_error("Too many stop-time rows for 32-bit indexes");
        }

        stop_times_by_stop_id.clear();
        stop_time_indices_by_stop_id.clear();
        stop_times_by_trip_id.clear();

        std::unordered_map<uint32_t, uint32_t> stop_counts;
        for (const auto& stop_time : stop_times) {
            ++stop_counts[stop_time.stop_id];
        }

        stop_times_by_stop_id.reserve(stop_counts.size());
        uint32_t next_offset = 0;
        for (auto& [stop_id, count] : stop_counts) {
            stop_times_by_stop_id.emplace(stop_id, IndexRange{next_offset, count});
            next_offset += count;
            count = 0;
        }

        stop_time_indices_by_stop_id.resize(stop_times.size());
        for (uint32_t index = 0; index < static_cast<uint32_t>(stop_times.size()); ++index) {
            const uint32_t stop_id = stop_times[index].stop_id;
            const auto range = stop_times_by_stop_id.at(stop_id);
            stop_time_indices_by_stop_id[range.begin + stop_counts[stop_id]++] = index;
        }

        size_t group_start = 0;
        while (group_start < stop_times.size()) {
            const auto& first = stop_times[group_start];
            size_t group_end = group_start + 1;
            while (
                group_end < stop_times.size() &&
                stop_times[group_end].feed_id == first.feed_id &&
                stop_times[group_end].trip_id == first.trip_id
            ) {
                ++group_end;
            }
            stop_times_by_trip_id[first.trip_id].push_back(IndexRange{
                static_cast<uint32_t>(group_start),
                static_cast<uint32_t>(group_end - group_start),
            });
            group_start = group_end;
        }
    }

    void clearRealtime() {
        realtime_trip_updates.clear();
        realtime_vehicle_positions.clear();
        realtime_alerts.clear();
        clearRealtimeIndexes();
    }

    void clear() {
        string_pool.clear();
        agencies.clear();
        calendars.clear();
        calendar_dates.clear();
        routes.clear();
        stops.clear();
        stop_times.clear();
        stop_times_by_stop_id.clear();
        stop_time_indices_by_stop_id.clear();
        stop_times_by_trip_id.clear();
        static_occupancies.clear();
        static_occupancies_by_trip_id.clear();
        trips.clear();
        transfers.clear();
        trips_by_route_id.clear();
        trips_by_service_id.clear();
        trips_by_block_id.clear();
        shapes.clear();
        shape_ranges_by_id.clear();
        feed_info.clear();

        clearRealtime();
        realtime_revision = 0;
    }

	void releaseStaticStorage() {
		clear();
		agencies.rehash(0);
		calendars.rehash(0);
		calendar_dates.rehash(0);
		routes.rehash(0);
		stops.rehash(0);
		stop_times.shrink_to_fit();
		stop_times_by_stop_id.rehash(0);
		stop_time_indices_by_stop_id.shrink_to_fit();
		stop_times_by_trip_id.rehash(0);
		static_occupancies.shrink_to_fit();
		static_occupancies_by_trip_id.rehash(0);
		trips.rehash(0);
		transfers.shrink_to_fit();
		trips_by_route_id.rehash(0);
		trips_by_service_id.rehash(0);
		trips_by_block_id.rehash(0);
		shapes.shrink_to_fit();
		shape_ranges_by_id.rehash(0);
		feed_info.shrink_to_fit();
		realtime_trip_updates.shrink_to_fit();
		realtime_vehicle_positions.shrink_to_fit();
		realtime_alerts.shrink_to_fit();
		realtime_trip_updates_by_trip_id.rehash(0);
		realtime_trip_updates_by_source_id.rehash(0);
		realtime_vehicle_positions_by_trip_id.rehash(0);
		realtime_vehicle_positions_by_source_id.rehash(0);
		realtime_alerts_by_source_id.rehash(0);
		string_pool.release();
	}

	bool validate(std::string& error) const {
		// Check stop-time index integrity
		if (stop_time_indices_by_stop_id.size() != stop_times.size()) {
			if (!stop_times.empty()) {
				error = "stop-time index size mismatch";
				return false;
			}
		}
		for (const auto& [stop_id, range] : stop_times_by_stop_id) {
			if (static_cast<uint64_t>(range.begin) + range.count > stop_time_indices_by_stop_id.size()) {
				error = "stop-time by-stop range out of bounds";
				return false;
			}
			for (uint32_t offset = 0; offset < range.count; ++offset) {
				uint32_t idx = stop_time_indices_by_stop_id[range.begin + offset];
				if (idx >= stop_times.size()) {
					error = "stop-time index out of bounds";
					return false;
				}
				if (stop_times[idx].stop_id != stop_id) {
					error = "stop-time by-stop index corruption";
					return false;
				}
			}
		}
		// Trip stop-time ranges must be within bounds and sorted
		size_t total_indexed = 0;
		for (const auto& [trip_id, ranges] : stop_times_by_trip_id) {
			for (const auto& range : ranges) {
				if (static_cast<uint64_t>(range.begin) + range.count > stop_times.size()) {
					error = "trip stop-time range out of bounds";
					return false;
				}
				total_indexed += range.count;
				for (uint32_t offset = 1; offset < range.count; ++offset) {
					if (stop_times[range.begin + offset].stop_sequence < stop_times[range.begin + offset - 1].stop_sequence) {
						error = "stop-times not sorted by sequence";
						return false;
					}
				}
			}
		}
		if (!stop_times.empty() && total_indexed != stop_times.size()) {
			error = "stop-time trip index count mismatch";
			return false;
		}
		// Trip indexes must reference existing trips
		for (const auto& [feed_id, by_route] : trips_by_route_id) {
			for (const auto& [route_id, vec] : by_route) {
				for (const Trip* trip : vec) {
					if (!trip) {
						error = "null trip in route index";
						return false;
					}
					auto feed_it = trips.find(feed_id);
					if (feed_it == trips.end() || feed_it->second.find(trip->trip_id) == feed_it->second.end()) {
						error = "route index references missing trip";
						return false;
					}
				}
			}
		}
		for (const auto& [feed_id, by_service] : trips_by_service_id) {
			for (const auto& [service_id, vec] : by_service) {
				for (const Trip* trip : vec) {
					if (!trip) {
						error = "null trip in service index";
						return false;
					}
				}
			}
		}
		// Shape ranges must be within bounds
		for (const auto& [shape_id, ranges] : shape_ranges_by_id) {
			for (const auto& [begin, end] : ranges) {
				if (end > shapes.size() || begin > end) {
					error = "shape range out of bounds";
					return false;
				}
			}
		}
		return true;
	}

    // Compiled snapshot persistence (versioned, bounds-checked, atomic)
    bool saveCompiledSnapshot(const std::string& path, std::string& error) const;
    bool loadCompiledSnapshot(const std::string& path, std::string& error);
    static uint32_t snapshotVersion() { return 2; }
    static uint32_t snapshotArchHash();
};

}

#endif
