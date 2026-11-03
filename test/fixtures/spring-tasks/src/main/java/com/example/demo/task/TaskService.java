package com.example.demo.task;

import com.example.demo.common.ConflictException;
import com.example.demo.common.NotFoundException;
import java.util.List;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

// Business rules live here, between the controller and the repository.
@Service
public class TaskService {

    private final TaskRepository repository;

    public TaskService(TaskRepository repository) {
        this.repository = repository;
    }

    @Transactional(readOnly = true)
    public List<TaskResponse> list(Boolean done) {
        List<Task> tasks = done == null ? repository.findAll() : repository.findByDoneOrderByIdAsc(done);
        return tasks.stream().map(TaskResponse::from).toList();
    }

    @Transactional(readOnly = true)
    public TaskResponse get(long id) {
        return TaskResponse.from(find(id));
    }

    @Transactional
    public TaskResponse create(TaskRequest request) {
        String title = request.title().trim();
        if (repository.existsByTitleIgnoreCase(title)) {
            throw new ConflictException("A task called \"" + title + "\" already exists");
        }
        return TaskResponse.from(repository.save(new Task(title, request.done())));
    }

    @Transactional
    public TaskResponse update(long id, TaskRequest request) {
        Task task = find(id);
        task.update(request.title().trim(), request.done());
        return TaskResponse.from(task);
    }

    @Transactional
    public void delete(long id) {
        repository.delete(find(id));
    }

    private Task find(long id) {
        return repository.findById(id).orElseThrow(() -> new NotFoundException("Task " + id + " was not found"));
    }
}
