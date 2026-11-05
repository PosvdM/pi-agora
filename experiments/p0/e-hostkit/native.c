#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#ifdef __APPLE__
#include <libproc.h>
#include <sys/mount.h>
#include <util.h>
#include <sys/ioctl.h>
#else
#error "P0 native implementation is macOS-only; Linux and Windows are pending."
#endif

static int describe(int pid, char *out, size_t size) {
    struct proc_bsdinfo p;
    int n = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &p, sizeof(p));
    if (n != sizeof(p)) return 0;
    snprintf(out, size, "{\"pid\":%u,\"ppid\":%u,\"pgid\":%u,\"status\":%u,\"startTime\":\"%llu.%06llu\"}",
        p.pbi_pid, p.pbi_ppid, p.pbi_pgid, p.pbi_status,
        (unsigned long long)p.pbi_start_tvsec, (unsigned long long)p.pbi_start_tvusec);
    return 1;
}
static char *snapshot(void) {
    int bytes = proc_listpids(PROC_ALL_PIDS, 0, NULL, 0);
    if (bytes <= 0) return NULL;
    int cap = bytes + 4096 * sizeof(pid_t);
    pid_t *pids = calloc(1, cap);
    char *out = calloc(1, (cap / sizeof(pid_t)) * 256 + 4);
    if (!pids || !out) { free(pids); free(out); return NULL; }
    bytes = proc_listpids(PROC_ALL_PIDS, 0, pids, cap);
    if (bytes <= 0) { free(pids); free(out); return NULL; }
    size_t used = 1;
    out[0] = '[';
    for (int i = 0; i < bytes / (int)sizeof(pid_t); i++) {
        char row[256];
        if (pids[i] > 0 && describe(pids[i], row, sizeof(row))) {
            if (used > 1) out[used++] = ',';
            size_t len = strlen(row); memcpy(out + used, row, len); used += len;
        }
    }
    out[used++] = ']'; out[used] = 0; free(pids); return out;
}
static int acquire(const char *path) {
    int fd = open(path, O_RDWR | O_CREAT | O_CLOEXEC, 0600);
    if (fd < 0) return -2;
    if (flock(fd, LOCK_EX | LOCK_NB) == 0) return fd;
    int saved = errno; close(fd); errno = saved;
    return (saved == EWOULDBLOCK || saved == EAGAIN) ? -1 : -2;
}

#ifdef ADDON
#include <node_api.h>
static napi_value error(napi_env env) { napi_throw_error(env, NULL, strerror(errno)); return NULL; }
static napi_value snap(napi_env env, napi_callback_info info) {
    (void)info; char *data = snapshot(); if (!data) return error(env);
    napi_value value; napi_create_string_utf8(env, data, NAPI_AUTO_LENGTH, &value); free(data); return value;
}
static napi_value lock(napi_env env, napi_callback_info info) {
    size_t argc = 1, len; napi_value arg; char path[4096];
    napi_get_cb_info(env, info, &argc, &arg, NULL, NULL);
    if (argc != 1 || napi_get_value_string_utf8(env, arg, path, sizeof(path), &len) != napi_ok || len >= sizeof(path)-1) {
        napi_throw_type_error(env, NULL, "lock requires a path shorter than 4095 bytes"); return NULL;
    }
    int fd = acquire(path); if (fd == -2) return error(env);
    napi_value value; napi_create_int32(env, fd, &value); return value;
}
static napi_value unlock(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value arg, value; int32_t fd;
    napi_get_cb_info(env, info, &argc, &arg, NULL, NULL);
    if (argc != 1 || napi_get_value_int32(env, arg, &fd) != napi_ok) { napi_throw_type_error(env, NULL, "fd required"); return NULL; }
    if (close(fd) < 0) return error(env);
    napi_get_undefined(env, &value); return value;
}
static napi_value init(napi_env env, napi_value exports) {
    napi_property_descriptor props[] = {
        {"snapshot", 0, snap, 0, 0, 0, napi_default, 0},
        {"lock", 0, lock, 0, 0, 0, napi_default, 0},
        {"unlock", 0, unlock, 0, 0, 0, napi_default, 0},
    };
    napi_define_properties(env, exports, 3, props); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
#else
int main(int argc, char **argv) {
    if (argc < 2) return 64;
    if (!strcmp(argv[1], "snapshot")) { char *s = snapshot(); if (!s) return 70; puts(s); free(s); return 0; }
    if (!strcmp(argv[1], "identity") && argc == 3) { char row[256]; if (!describe(atoi(argv[2]), row, sizeof(row))) return 3; puts(row); return 0; }
    if (!strcmp(argv[1], "fs") && argc == 3) {
        struct statfs s; if (statfs(argv[2], &s)) { perror("statfs"); return 70; }
        printf("{\"local\":%s,\"type\":\"%s\"}\n", (s.f_flags & MNT_LOCAL) ? "true" : "false", s.f_fstypename); return 0;
    }
    if (!strcmp(argv[1], "lock") && argc == 3) {
        int fd = acquire(argv[2]); if (fd == -2) { perror("flock"); return 70; }
        printf("{\"held\":%s,\"pid\":%d}\n", fd >= 0 ? "true" : "false", getpid()); fflush(stdout);
        if (fd < 0) return 2;
        char c; while (read(STDIN_FILENO, &c, 1) > 0) {} close(fd); return 0;
    }
    if (!strcmp(argv[1], "gate") && argc >= 3) {
        // fd 3 belongs only to the host. EOF fails closed; stdin remains pi's RPC input.
        char c; if (read(3, &c, 1) != 1 || c != 'G') return 75;
        close(3); execvp(argv[2], &argv[2]); perror("exec"); return 70;
    }
    if (!strcmp(argv[1], "escape") && argc == 4) {
        pid_t child = fork(); if (child < 0) return 70;
        if (child > 0) return 0;
        if (setsid() < 0) _exit(70);
        signal(SIGHUP, SIG_IGN); signal(SIGTERM, SIG_IGN);
        int fd = open("/dev/null", O_RDWR); dup2(fd, 0); dup2(fd, 1); dup2(fd, 2); if (fd > 2) close(fd);
        FILE *log = fopen(argv[2], "a"); char row[256]; describe(getpid(), row, sizeof(row)); fprintf(log, "%s\n", row); fclose(log);
        // The test's release file keeps this process observable without polling the process table faster.
        while (access(argv[3], F_OK)) usleep(10000);
        _exit(0);
    }
    if (!strcmp(argv[1], "pty") && argc >= 3) {
        int master, slave; if (openpty(&master, &slave, NULL, NULL, NULL)) return 70;
        pid_t child = fork(); if (child < 0) return 70;
        if (!child) {
            close(master); setsid(); ioctl(slave, TIOCSCTTY, 0); tcsetpgrp(slave, getpid());
            dup2(slave, 0); dup2(slave, 1); dup2(slave, 2); if (slave > 2) close(slave);
            execvp(argv[2], &argv[2]); _exit(70);
        }
        close(slave); printf("{\"terminalPid\":%d}\n", child); fflush(stdout);
        char c; read(0, &c, 1); close(master);
        int status; waitpid(child, &status, 0); printf("{\"terminalWaitStatus\":%d}\n", status); return 0;
    }
    return 64;
}
#endif
